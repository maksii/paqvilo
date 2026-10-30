import { parseDataverseDecimalString } from './dataverse-decimal-input.mjs';
import { readFile, mkdir, rename, open, unlink, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { cloneStateData } from './state-clone.mjs';
import fsSync from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { RecordPageSession, pagedRecordsOf } from './record-tables.mjs';
import { recordSources } from './record-sources.mjs';
import { compactRecordGraph } from './record-compaction.mjs';
import { privateRecordEqual } from './record-clone.mjs';
import { collectRecordGarbage } from './record-file-lease.mjs';
import { encodeRecordReferences } from './record-state.mjs';
import { systemClock, systemIds } from './runtime-clock.mjs';
import { currentRequest } from './request-context.mjs';
import { takeNativeFormContactAssociation } from './native-form-association.mjs';
import { builtinPresets, resolvePreset, compactBuiltinPresets, applyPresetSections } from './presets.mjs';
// Preset functions live in presets.mjs; these re-exports keep existing imports working.
export { resolvePreset, compactBuiltinPresets };
import { expressionOperator } from './extensions.mjs';
import { createHash } from 'node:crypto';

import { DataError } from './data-error.mjs';
import {
  activeAlternateKeys,
  alternateKeyAttributes,
  alternateKeyValues,
  alternateKeyKinds,
  alternateKeyOf,
  duplicateAlternateKey,
} from './alternate-key-values.mjs';
import { assertElasticRecord, isElastic, samePartition, recordKey } from './dataverse-elastic.mjs';
import { relationshipsOf } from './dataverse-standard.mjs';
import { StateStorage } from './state-storage.mjs';
import { RowTransaction, validateRowIndex, assignRowValues } from './row-transaction.mjs';
import { jsonChunks, stateDigest } from './state-stream.mjs';
import { initializationFingerprint, initializationDelta, initializationEntries } from './state-initialization.mjs';
import { validatePersonaCatalog } from './persona-catalog.mjs';
import { platformValues, validatePlatformOverrides, assertAttachmentPolicy } from './platform-settings.mjs';
import { platformConfig, applyPlatformConfig } from './platform-config.mjs';
import { validateExperimentPresets } from './experiment-presets.mjs';
import { attachODataReaderDetails, odataConversionDetails } from './webapi-error-details.mjs';
import { attachDataverseReaderDetails } from './dataverse-reader-details.mjs';
import {
  isExactNumeric,
  exactNumeric,
  decimalParts,
  compareNumeric,
  roundNumeric,
  sumNumeric,
  multiplyNumeric,
  parseNumericLiteral,
} from './exact-numeric.mjs';
import { odataToSdkQuery, sameSdkQuery } from './plugin-query.mjs';
import { pluginStepBypassed } from './plugin-bypass.mjs';
import { compilePermissionFetchXml, serializePermissionFetchXml } from './permission-query.mjs';
import { rebindPermissionQuery } from './permission-query-mutation.mjs';
import { preparePortalFetchXml } from './portal-fetchxml.mjs';
import { compileODataPermissionQuery, authoredScalarODataFetch } from './odata-permission-query.mjs';
import { assertPortalFetchXmlTransport } from './portal-fetch-transport.mjs';
import { recordToSdkEntity, recordToSdkReadEntity, sdkQueryParameters, executeSdkFetch } from './plugin-clr.mjs';
import { queryExpressionToFetch, fetchResultToSdkCollection } from './plugin-sdk-query.mjs';
import { sdkValueToRecord } from './local-organization-service.mjs';
import { handoffPluginResponse } from './plugin-response.mjs';
import { assertPluginExecutionActive, pluginInvocationDepth } from './plugin-execution-lifetime.mjs';
import { runStateMessage } from './plugin-platform-messages.mjs';
import {
  storeOperationFields,
  hasStoreOperationContext,
  storeOperationValue,
  setStoreOperationValue,
  withStoreOperationContext,
} from './store-operation-context.mjs';
import { executeFetch, parseXmlDocument, planFetch, structuralIntersects } from './fetchxml-engine.mjs';
import {
  columnValue,
  compileODataPredicate,
  evaluateApply,
  parseApply,
  parseExpand,
  parseODataExpression,
  parseOrderBy,
  parseSelect,
  sortRows,
} from './odata-query.mjs';
import {
  fieldKind,
  formatDotNetDate,
  primaryNameValue,
  isDateOnlyField,
  GUID_PATTERN,
  isoUtc,
  parseDateValue,
  dateTimeRangeError,
  valuesEqual,
  looksLikeDate,
  guidKey,
  foldText,
  makeSortKey,
  compareSortKeys,
} from './dataverse-values.mjs';
// The store's query error type lives in data-error.mjs; this re-export keeps imports working.
export { DataError };
const clone = cloneStateData;
const cloneInternal = (value) => cloneStateData(value, { forkTables: true });
// Per async context, the transaction frame of each DataStore (see DataStore#transact).
const transactionFrames = new AsyncLocalStorage();
const transactionFrameOf = (store, { closed = false } = {}) => {
  for (let frame = transactionFrames.getStore(); frame; frame = frame.parent)
    if (frame.store === store && (closed || !frame.closed)) return frame;
  return null;
};
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
// Row columns a write's Target never shows: the row version, and empty on-behalf/team ownership lookups
// (native Create Targets carry an empty modifiedonbehalfby, never an empty createdonbehalfby or owningteam).
const notInTarget = (name, value) =>
  name === 'versionnumber' || (value == null && (name === 'createdonbehalfby' || name === 'owningteam'));
// Update stamps the platform adds to the Target after PreValidation (native PreOperation/PostOperation Update).
const UPDATE_TARGET_STAMPS = ['modifiedon', 'modifiedby', 'modifiedonbehalfby'];
// A Web API string column written as null or empty reaches the Target as an empty string; the row stores null.
function blankTextColumns(store, mapping, input, options) {
  if (!options.dataverseWebApi) return [];
  return Object.keys(input).filter(
    (name) =>
      (input[name] === null || input[name] === '') &&
      fieldKind(store.fieldDefinition(mapping.logicalName, name, options.metadata)) === 'string',
  );
}
const formattedAnnotation = '@OData.Community.Display.V1.FormattedValue';
const lookupAnnotation = '@Microsoft.Dynamics.CRM.lookuplogicalname';

function committedPluginParent(store, mapping, operation, target, row, options) {
  const tag = store.pluginSdkTag,
    values = {
      ...(tag === undefined ? {} : { tag }),
      ...(operation === 'update'
        ? { ConcurrencyBehavior: { $type: 'ConcurrencyBehavior', value: options.pluginConcurrencyBehavior ?? 0 } }
        : {}),
      ...(operation === 'create' && options.sdkFromSandbox === true ? { FromSandbox: true } : {}),
    };
  return {
    primaryId: row[mapping.idColumn],
    // Preserve the pre-PostOperation baseline without imposing the SDK codec
    // on ordinary writes. Only an admitted asynchronous observer needs it.
    target: { ...clone(target), [mapping.idColumn]: row[mapping.idColumn] },
    inputParameters: { $type: 'ParameterCollection', values },
    sharedVariables: { $type: 'ParameterCollection', values: tag === undefined ? {} : { tag } },
    childSharedVariables: {
      $type: 'ParameterCollection',
      values: {
        AcceptLang: options.pluginAcceptLanguage ?? '',
        IsAutoTransact: true,
        ...(operation === 'create' ? { DefaultsAddedFlag: true } : {}),
        ...(tag === undefined ? {} : { tag }),
      },
    },
  };
}

// Native corpus (pipelineEffects): an asynchronous step sees the operation as it stood when PostOperation began.
// Target edits, OutputParameters and SharedVariables written by synchronous PostOperation steps do not reach it, so
// the queued event keeps the pre-PostOperation parameters and the async run populates the system outputs itself.
function prePostOperationFrame(frame) {
  return {
    inputParameters: clone(frame?.inputParameters),
    outputParameters: clone(frame?.outputParameters),
    sharedVariables: clone(frame?.sharedVariables),
  };
}
const queuedFrame = (frame, before, asyncSourceParent) => ({
  ...(frame ?? {}),
  ...before,
  systemOutputsPopulated: false,
  asyncSourceParent,
});

const metadataField = (mapping, key) => {
  const fields = mapping?.fields ?? mapping?.fieldMetadata ?? {};
  return fields[key] ?? fields[Object.keys(fields).find((name) => name.toLowerCase() === key.toLowerCase())];
};
const choiceDefinition = (definition) => {
  const type = String(definition?.dataverseType ?? definition?.type ?? '').toLowerCase();
  return (
    ['picklist', 'state', 'status', 'choice', 'optionset'].includes(type) ||
    (Array.isArray(definition?.options) &&
      !['bit', 'boolean', 'int', 'integer', 'bigint', 'decimal', 'double', 'float', 'money'].includes(type))
  );
};
const choiceLabel = (definition, value) =>
  Array.isArray(definition?.options)
    ? definition.options.find((option) => Number(option.value) === Number(value))?.label
    : undefined;

/** Native Liquid entity.id is metadata, not an additional Dataverse JSON column. */
export function withLiquidEntityId(record, mapping = {}, { aggregate = false } = {}) {
  const primary = mapping?.idColumn && record?.[mapping.idColumn];
  if (!aggregate && primary != null && !own(record, 'id'))
    Object.defineProperty(record, 'id', {
      value: scalar(primary),
      enumerable: false,
      configurable: true,
    });
  return record;
}

/** Format permission-filtered local reads for Liquid; never change persisted/API scalars. */
export function normalizeMockLiquidRecord(
  record,
  mapping = {},
  { aggregate = false, mappings = {}, aliasFields = {} } = {},
) {
  if (record == null || typeof record !== 'object') return record;
  if (Array.isArray(record))
    return record.map((row) =>
      normalizeMockLiquidRecord(row, mapping, {
        aggregate,
        mappings,
        aliasFields,
      }),
    );
  const out = clone(record);
  for (const [key, value] of Object.entries(record)) {
    if (key.includes('@')) continue;
    const definition = aliasFields[key] ?? metadataField(mapping, key);
    if (!aggregate && typeof value === 'number' && choiceDefinition(definition)) {
      out[key] = {
        value,
        label: choiceLabel(definition, value) ?? record[key + formattedAnnotation] ?? '',
      };
    } else if (value && typeof value === 'object' && !Array.isArray(value) && own(value, 'value')) {
      // Preserve explicit typed fixture values. A label omitted by a caller may
      // be supplied from metadata without mutating that caller's record.
      if (!aggregate && choiceDefinition(definition) && !own(value, 'label'))
        out[key].label = choiceLabel(definition, value.value) ?? '';
    } else if (value && typeof value === 'object' && mapping.relationships?.[key] && !own(value, 'id')) {
      const target = mapping.relationships[key].entity;
      const targetMapping = typeof mappings === 'function' ? mappings(target) : mappings[target];
      out[key] = normalizeMockLiquidRecord(value, targetMapping ?? {}, {
        aggregate,
        mappings,
      });
    }
  }
  return withLiquidEntityId(out, mapping, { aggregate });
}

/** Resolve attribute aliases from the authored FetchXML, retaining aggregates as numbers. */
export function normalizeMockLiquidFetchXml(result, xml, mappingResolver) {
  const fetch = parseFetchXml(xml),
    root = fetch.children.find((node) => node.name === 'entity');
  if (!root) throw new DataError('FetchXML requires a root entity');
  const resolve = (name) =>
    typeof mappingResolver === 'function' ? mappingResolver(name) : (mappingResolver?.[name] ?? {});
  const mapping = resolve(root.attrs.name),
    aliasFields = {};
  let serial = 0;
  const collect = (node, alias = null) => {
    const current = resolve(node.attrs.name);
    if (alias)
      for (const [key, definition] of Object.entries(current.fields ?? current.fieldMetadata ?? {}))
        aliasFields[alias + '.' + key] = definition;
    for (const attribute of node.children.filter((child) => child.name === 'attribute')) {
      const key = attribute.attrs.alias ?? (alias ? alias + '.' : '') + attribute.attrs.name;
      aliasFields[key] = metadataField(current, attribute.attrs.name);
    }
    for (const link of node.children.filter((child) => child.name === 'link-entity'))
      collect(link, link.attrs.alias ?? `${link.attrs.name}${++serial}`);
  };
  collect(root);
  // Evaluator results describe their output columns exactly (generated
  // aliases count every link-entity in document order, including filters).
  if (result.columns) {
    for (const [alias, logical] of Object.entries(result.columns.aliases ?? {})) {
      const current = resolve(logical);
      for (const [key, definition] of Object.entries(current.fields ?? current.fieldMetadata ?? {}))
        aliasFields[alias + '.' + key] ??= definition;
    }
    for (const column of result.columns.columns ?? [])
      aliasFields[column.key] = metadataField(resolve(column.entity), column.attribute);
  }
  return {
    ...result,
    entities: (result.entities ?? []).map((row) =>
      normalizeMockLiquidRecord(row, mapping, {
        aggregate: fetch.attrs.aggregate === 'true',
        aliasFields,
        mappings: resolve,
      }),
    ),
  };
}

/** API serialization only. Liquid and the persisted workspace retain their typed values. */
export function formatMockRecord(record, mapping = {}, mappings = {}, tables = {}) {
  if (!record || typeof record !== 'object') return record;
  if (Array.isArray(record)) return record.map((row) => formatMockRecord(row, mapping, mappings, tables));
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (/^__simArtifact(?:$|[/.])/i.test(key)) continue;
    if (key.includes('@')) {
      out[key] = value;
      continue;
    }
    const relationship = mapping.relationships?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && own(value, 'id') && own(value, 'logical_name')) {
      const name = key.includes('.') || /^_.*_value$/.test(key) ? key : `_${key}_value`;
      out[name] = value.id;
      const targetMapping = mappings[value.logical_name] ?? {};
      const target = (tables[value.logical_name] ?? []).find(
        (row) =>
          String(row[targetMapping.idColumn ?? `${value.logical_name}id`]).toLowerCase() ===
          String(value.id).toLowerCase(),
      );
      out[name + formattedAnnotation] = value.name ?? primaryNameValue(targetMapping, target, value.logical_name) ?? '';
      out[name + lookupAnnotation] = value.logical_name;
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      own(value, 'value') &&
      own(value, 'label')
    ) {
      out[key] = value.value;
      out[key + formattedAnnotation] = value.label;
    } else if (value && typeof value === 'object' && relationship) {
      out[key] = formatMockRecord(value, mappings[relationship.entity] ?? {}, mappings, tables);
    } else {
      out[key] = value;
      const definition = metadataField(mapping, key);
      if (typeof value === 'number' && choiceDefinition(definition)) {
        const label = choiceLabel(definition, value);
        if (label != null) out[key + formattedAnnotation] = label;
      } else if (
        typeof value === 'number' &&
        ['int', 'integer', 'bigint'].includes(String(definition?.dataverseType ?? definition?.type ?? '').toLowerCase())
      ) {
        out[key + formattedAnnotation] = value.toLocaleString('en-US');
      }
      const physical = key.startsWith('_') && key.endsWith('_value') ? key.slice(1, -6) : key;
      const rel = Object.values(mapping.relationships ?? {}).find((r) => r.many === false && r.from === physical);
      if (rel && value != null && typeof value !== 'object') {
        const targetMapping = mappings[rel.entity] ?? {};
        const target = (tables[rel.entity] ?? []).find(
          (row) => String(row[targetMapping.idColumn ?? rel.to]).toLowerCase() === String(value).toLowerCase(),
        );
        const name = key.includes('.') || /^_.*_value$/.test(key) ? key : `_${key}_value`;
        out[name] = value;
        out[name + lookupAnnotation] = rel.entity;
        if (target) out[name + formattedAnnotation] = primaryNameValue(targetMapping, target, rel.entity) ?? '';
      }
    }
  }
  return out;
}

const safeName = (name) => {
  if (!/^[\w.-]+$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))
    throw new DataError(`Invalid entity or field name: ${name}`);
  return name;
};
const scalar = (value) => (value && typeof value === 'object' ? (value.id ?? value.value ?? value) : value);
const comparable = (value) => {
  const v = scalar(value);
  return String(typeof v === 'boolean' ? Number(v) : v)
    .replace(
      /^(?:\{([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\}|\(([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\))$/i,
      (_match, braced, parenthesized) => braced ?? parenthesized,
    )
    .toLowerCase();
};
const equal = (a, b) => (a == null || b == null ? a == null && b == null : comparable(a) === comparable(b));
const field = (row, name) =>
  own(row, name)
    ? row[name]
    : name.startsWith('_') && name.endsWith('_value')
      ? scalar(row[name.slice(1, -6)])
      : name.split('/').reduce((v, k) => v?.[k], row);
const insertSorted = (list, value) => {
  if (!list.length || list.at(-1) < value) {
    list.push(value);
    return;
  }
  let low = 0,
    high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] < value) low = middle + 1;
    else high = middle;
  }
  list.splice(low, 0, value);
};
/**
 * Ascending row positions by a derived key, for one row array. Unique keys keep
 * one scalar position; only duplicate keys retain a position array.
 * keyOf(row) answers a string key, null (the row can never match) or undefined (the row
 * cannot be keyed: a `wild` index keeps it in a list that every lookup also scans; any other
 * index becomes `linear` and callers scan). The maintenance methods answer false when the
 * owner should drop the index instead of updating it.
 */
class RowKeyIndex {
  constructor(rows, keyOf, { frame, wild = false } = {}) {
    this.keyOf = keyOf;
    this.frame = frame;
    this.wild = wild ? [] : null;
    this.map = new Map();
    this.linear = false;
    this.length = rows.length;
    for (let index = 0; index < rows.length; index++)
      if (!this.add(keyOf(rows[index]), index)) {
        this.linear = true;
        this.map.clear();
        break;
      }
  }
  add(key, index) {
    if (key === null) return true;
    if (key === undefined) {
      if (!this.wild) return false;
      insertSorted(this.wild, index);
      return true;
    }
    const list = this.map.get(key);
    if (list === undefined) this.map.set(key, index);
    else if (typeof list === 'number') this.map.set(key, list <= index ? [list, index] : [index, list]);
    else insertSorted(list, index);
    return true;
  }
  delete(key, index) {
    const list = key === undefined ? this.wild : key === null ? null : this.map.get(key);
    if (typeof list === 'number') {
      if (list === index) this.map.delete(key);
      return;
    }
    const at = list ? list.indexOf(index) : -1;
    if (at < 0) return;
    list.splice(at, 1);
    if (!list.length && key != null) this.map.delete(key);
    else if (list.length === 1 && key != null) this.map.set(key, list[0]);
  }
  get(key) {
    const positions = this.map.get(key);
    return typeof positions === 'number' ? [positions] : (positions ?? []);
  }
  appended(rows, row) {
    if (this.linear || this.length !== rows.length - 1) return false;
    this.length = rows.length;
    return this.add(this.keyOf(row), rows.length - 1);
  }
  moved(rows, index, previousRow, row, previousKey) {
    if (this.linear || this.length !== rows.length) return false;
    // undefined is a valid captured wild key. A default parameter would
    // re-read the already-mutated/null previous row and lose that distinction.
    if (arguments.length < 5) previousKey = this.keyOf(previousRow);
    const key = this.keyOf(row);
    if (key === previousKey) return true;
    if (previousKey === undefined && !this.wild) return false;
    this.delete(previousKey, index);
    return this.add(key, index);
  }
  removed(rows, index, row) {
    if (this.linear || this.length !== rows.length + 1) return false;
    this.delete(this.keyOf(row), index);
    const shift = (list) => {
      for (let i = 0; i < list.length; i++) if (list[i] > index) list[i]--;
    };
    this.map.forEach((list, key) => {
      if (typeof list === 'number') {
        if (list > index) this.map.set(key, list - 1);
      } else shift(list);
    });
    if (this.wild) shift(this.wild);
    this.length = rows.length;
    return true;
  }
}
const primaryKeyFns = new Map();
/** Primary-key index key: string ids only (other values keep the linear coercive scan). */
const primaryKeyOf = (column) => {
  if (!primaryKeyFns.has(column))
    primaryKeyFns.set(column, (row) => {
      const value = row?.[column];
      return typeof value === 'string' ? comparable(value) : undefined;
    });
  return primaryKeyFns.get(column);
};
/**
 * Key-segment lookup index key (findByKey): a bucket that every valuesEqual match shares. Only
 * plain non-date strings are bucketed (GUID key, else collation-folded text); other values are
 * `undefined` and stay in the index's always-scanned list. Candidates are verified with valuesEqual.
 */
const keySegmentOf = (names, collation, kinds) => (row) => {
  const parts = [];
  let wild = false;
  for (const name of names) {
    const value = field(row, name);
    const bucket = keySegmentBucket(value, collation, kinds[name]);
    if (bucket === null) return null;
    if (bucket === undefined) wild = true;
    else parts.push(bucket);
  }
  return wild ? undefined : JSON.stringify(parts);
};
const keySegmentBucket = (value, collation, kind) => {
  if (value == null || isExactNumeric(value)) return value == null ? null : undefined;
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value.id ?? value.value ?? value) : value;
  if (raw == null) return null;
  if (
    typeof raw !== 'string' ||
    (kind && !['string', 'guid', 'lookup'].includes(kind)) ||
    (kind !== 'string' && looksLikeDate(raw))
  )
    return undefined;
  const guid = guidKey(raw);
  return guid ? `g${guid}` : `t${foldText(raw, collation)}`;
};
/** Restore `current` to `saved` in place, keeping the identity of tables, rows and sections that callers hold. */
const restoreInPlace = (current, saved) => {
  if (Array.isArray(current) && Array.isArray(saved)) {
    for (let i = 0; i < saved.length; i++) current[i] = restoreInPlace(current[i], saved[i]);
    current.length = saved.length;
    return current;
  }
  if (
    current &&
    saved &&
    typeof current === 'object' &&
    typeof saved === 'object' &&
    !Array.isArray(current) &&
    !Array.isArray(saved)
  ) {
    for (const key of Object.keys(current)) if (!own(saved, key)) delete current[key];
    for (const [key, value] of Object.entries(saved)) current[key] = restoreInPlace(current[key], value);
    return current;
  }
  return clone(saved);
};
/**
 * Key-set continuation for a paged query: the rows strictly after the cursor, in the same order sortRows
 * gives a public page (keys, then the primary-key tie breaker, then input position), keeping only the
 * first `limit` of them. `before` counts the rows up to and including the cursor, which is the offset
 * the page continues from. The cursor is { id, values } (the previous page's last order-column values,
 * as cursorText wrote them, by path, and its primary key): the page resumes after that tuple, so a
 * cursor row deleted or filtered out since skips nothing. A bare id (or values that cannot be read
 * back, see cursorValue) resumes after that row while it is still in the result; null otherwise, and
 * the caller then uses the offset.
 */
export function keysetPage(
  rows,
  specs,
  { mapping, valueOf, definition, lookupName, collation = 'CI_AI' },
  cursor,
  limit,
) {
  const keyed = rows.map((row, index) => ({
    row,
    index,
    keys: specs.map((spec) =>
      makeSortKey(valueOf(row, spec.path), { definition: definition(spec.path), rawChoice: false, lookupName }),
    ),
    pk: makeSortKey(row?.[mapping.idColumn], { definition: { dataverseType: 'primarykey' } }),
  }));
  const compare = (a, b) => {
    for (let i = 0; i < specs.length; i++) {
      const result = compareSortKeys(a.keys[i], b.keys[i], collation);
      if (result) return specs[i].descending ? -result : result;
    }
    return compareSortKeys(a.pk, b.pk, collation) || a.index - b.index;
  };
  const afterId = cursor !== null && typeof cursor === 'object' ? cursor.id : cursor;
  const saved = cursor?.values
    ? specs.map((spec) => cursorValue(cursor.values, spec.path, definition(spec.path), mapping))
    : null;
  // The saved tuple stands in for the cursor row; index Infinity puts that row itself (same key and id) before it.
  const last =
    saved && !saved.includes(undefined)
      ? {
          index: Infinity,
          keys: saved.map((value, i) =>
            makeSortKey(value, { definition: definition(specs[i].path), rawChoice: false, lookupName }),
          ),
          pk: makeSortKey(afterId, { definition: { dataverseType: 'primarykey' } }),
        }
      : keyed.find((entry) => equal(entry.row[mapping.idColumn], afterId));
  if (!last) return null;
  // The `limit` smallest rows after `last`, through a bounded max-heap: O(n log limit), not a full sort.
  const heap = [];
  let after = 0;
  const swap = (i, j) => {
    const item = heap[i];
    heap[i] = heap[j];
    heap[j] = item;
  };
  const up = (i) => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(heap[i], heap[parent]) <= 0) break;
      swap(i, parent);
      i = parent;
    }
  };
  const down = (i) => {
    for (;;) {
      const left = 2 * i + 1,
        right = left + 1;
      let largest = i;
      if (left < heap.length && compare(heap[left], heap[largest]) > 0) largest = left;
      if (right < heap.length && compare(heap[right], heap[largest]) > 0) largest = right;
      if (largest === i) return;
      swap(i, largest);
      i = largest;
    }
  };
  for (const entry of keyed) {
    if (compare(entry, last) <= 0) continue;
    after++;
    if (heap.length < limit) {
      heap.push(entry);
      up(heap.length - 1);
    } else if (limit > 0 && compare(entry, heap[0]) < 0) {
      heap[0] = entry;
      down(0);
    }
  }
  return { before: keyed.length - after, rows: heap.sort(compare).map((entry) => entry.row) };
}
/** The text a paging cookie carries for an order-column value: "" for null, a lookup's id, a choice's value, exact digits. */
function cursorText(value) {
  const raw = isExactNumeric(value)
    ? value.value
    : value !== null && typeof value === 'object'
      ? (value.id ?? value.value ?? null)
      : value;
  return raw == null ? '' : String(raw);
}
/**
 * The order-column value a paging cookie saved (cursorText), read back in the column's type so its sort key equals
 * the row's own. undefined when it cannot be read back exactly; keysetPage then resumes after the cursor row by id.
 */
// ponytail: multi-segment paths, multi-select choices, untyped columns and lookups without a single N:1 target fall
// back to the cursor row; a typed cursor per path kind is the upgrade.
function cursorValue(values, path, definition, mapping) {
  const name = path.join('/');
  if (path.length !== 1 || !own(values, name)) return undefined;
  const text = values[name];
  if (text === '' || text == null) return null;
  const kind = fieldKind(definition);
  if (['integer', 'number', 'decimal', 'money', 'double'].includes(kind))
    return decimalParts(text) ? parseNumericLiteral(text) : undefined;
  if (kind === 'boolean') return text === 'true' || text === '1';
  if (kind === 'choice') return Number.isFinite(Number(text)) ? Number(text) : undefined;
  if (kind === 'lookup') {
    // A bare _x_value path reads the lookup id (columnValue); the lookup column itself sorts by the target's name.
    if (/^_.+_value$/.test(name)) return text;
    const rel = Object.values(mapping.relationships ?? {}).find((item) => item?.many === false && item.from === name);
    return rel?.entity ? { id: text, logical_name: rel.entity } : undefined;
  }
  if (['string', 'datetime', 'primarykey', 'guid'].includes(kind)) return text;
  return undefined;
}
/** Small non-resolving XML parser: external entities and doctypes are rejected. */
export function parseFetchXml(source) {
  return parseXmlDocument(source, { root: 'fetch' });
}
const splitTop = (text, separator = ',') => {
  const out = [];
  let start = 0,
    depth = 0,
    quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      if (quote && text[i + 1] === "'") {
        i++;
        continue;
      }
      quote = !quote;
    }
    if (quote) continue;
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === separator && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
};

// Plugin predicates evaluate a single in-memory record: "/" reads nested
// object members, not relationships, and the extended dialect keeps the
// simulator's convenience functions (tolower, length, in, ...).
const pluginMapping = { logicalName: 'record', idColumn: 'id', relationships: {} };
const pluginContext = {
  dialect: 'extended',
  navigate: (_mapping, row, name) =>
    row && typeof row === 'object' && own(row, name)
      ? { mapping: pluginMapping, value: row[name], many: false }
      : { mapping: pluginMapping, value: undefined, many: false },
  definition: () => undefined,
  settings: {},
  identity: {},
};

/** Compile rather than eval OData expressions. Unknown syntax always fails visibly. */
export function compileFilter(source) {
  if (!source) return () => true;
  const predicate = compileODataPredicate(parseODataExpression(source, { dialect: 'extended' }), pluginMapping, {
    ...pluginContext,
    now: Date.now(),
  });
  return (row) => predicate(row);
}

export function emptyState() {
  return {
    version: 1,
    mappings: {},
    tables: {},
    permissions: [],
    plugins: [],
    presets: {},
    settings: { permissionMode: 'enforce' },
  };
}
export function reconcilePermissionDiagnostics(state) {
  if (!state.simulator) return state;
  const byId = new Map((state.permissions ?? []).map((p) => [p.id, p]));
  const codes = new Set(['PERMISSION_MAPPING_REQUIRED', 'PERMISSION_ENTITY_UNRESOLVED']);
  const existing = (state.simulator.importDiagnostics ?? [])
    .filter((d) => !codes.has(d.code) || byId.get(d.id)?.enabled === false)
    .map((d) =>
      codes.has(d.code) && byId.get(d.id)?.disabledReason
        ? {
            ...d,
            entity: byId.get(d.id).entity,
            message: byId.get(d.id).disabledReason,
          }
        : d,
    );
  const seen = new Set(existing.filter((d) => codes.has(d.code)).map((d) => d.id));
  for (const p of state.permissions ?? [])
    if (p.imported && p.enabled === false && p.disabledReason && !seen.has(p.id))
      existing.push({
        code: 'PERMISSION_MAPPING_REQUIRED',
        id: p.id,
        entity: p.entity,
        message: p.disabledReason,
      });
  state.simulator.importDiagnostics = existing;
  return state;
}
function normalizeState(
  state,
  presetLibrary = builtinPresets,
  platform = state?.simulator?.platformDefaults,
  owned = false,
) {
  const result = {
    ...emptyState(),
    ...(owned ? (value) => value : cloneInternal)(
      state ? { ...state, presets: compactBuiltinPresets(state.presets ?? {}, presetLibrary) } : state,
    ),
    settings: { ...emptyState().settings, ...state?.settings },
  };
  validatePlatformOverrides(result.simulator?.platformOverrides);
  validateExperimentPresets(result.simulator?.experimentPresets);
  if (result.personaCatalog !== undefined)
    result.personaCatalog = validatePersonaCatalog(result.personaCatalog, 'State');
  for (const key of ['mappings', 'tables', 'presets'])
    if (!result[key] || Array.isArray(result[key]) || typeof result[key] !== 'object')
      throw new DataError(`${key} must be an object`);
  for (const key of ['permissions', 'plugins'])
    if (!Array.isArray(result[key])) throw new DataError(`${key} must be an array`);
  if (!['enforce', 'permissive'].includes(result.settings.permissionMode))
    throw new DataError('Unknown permissionMode');
  if (
    result.settings.associationPermissions !== undefined &&
    !['enforce', 'compatibility'].includes(result.settings.associationPermissions)
  )
    throw new DataError('Unknown associationPermissions mode');
  for (const [name, rows] of Object.entries(result.tables)) {
    safeName(name);
    if (!Array.isArray(rows)) throw new DataError(`Table ${name} must be an array`);
    if (pagedRecordsOf(rows)) continue;
    for (const row of rows)
      if (!row || Array.isArray(row) || typeof row !== 'object') throw new DataError(`Invalid row in ${name}`);
  }
  for (const [name, m] of Object.entries(result.mappings)) {
    safeName(name);
    if (m.entitySet) safeName(m.entitySet);
    if (m.idColumn) safeName(m.idColumn);
  }
  const entitySets = new Set();
  for (const [name, m] of Object.entries(result.mappings)) {
    if (m.entitySet) {
      if (entitySets.has(m.entitySet)) throw new DataError(`Duplicate entitySet ${m.entitySet}`);
      entitySets.add(m.entitySet);
    }
    for (const [nav, rel] of Object.entries(m.relationships ?? {})) {
      safeName(nav);
      if (!rel.entity || !rel.from || !rel.to) throw new DataError(`Relationship ${name}.${nav} needs entity/from/to`);
      safeName(rel.entity);
      safeName(rel.from);
      safeName(rel.to);
    }
  }
  for (const rule of result.permissions) {
    if (!rule.entity) throw new DataError('Permission requires entity');
    if (rule.entity !== '*') safeName(rule.entity);
    if (rule.enabled !== false && !['global', 'contact', 'account', 'self', 'parent'].includes(rule.scope ?? 'global'))
      throw new DataError(`Unsupported permission scope ${rule.scope}`);
    if (rule.operations && !Array.isArray(rule.operations))
      throw new DataError('Permission operations must be an array');
    for (const op of rule.operations ?? [])
      if (!['read', 'create', 'update', 'delete', 'append', 'appendTo'].includes(op))
        throw new DataError(`Unknown permission operation ${op}`);
    if (rule.roles && !Array.isArray(rule.roles)) throw new DataError('Permission roles must be an array');
    if (
      rule.enabled !== false &&
      rule.scope === 'parent' &&
      (!rule.relationship?.entity || !rule.relationship.from || !rule.relationship.to)
    )
      throw new DataError('Parent permission requires relationship entity/from/to');
  }
  const checkExpr = (expr) => {
    if (expr && typeof expr === 'object' && !Array.isArray(expr) && !own(expr, 'literal')) {
      if (
        ![
          'concat',
          'coalesce',
          'lower',
          'upper',
          'sum',
          'multiply',
          'uuid',
          'sequence',
          'now',
          'split',
          'join',
          'length',
          'lookup',
          'find',
          'findMany',
          'related',
          'reference',
        ].includes(expr.op) &&
        !expressionOperator(expr.op)
      )
        throw new DataError(`Unsupported plugin expression ${expr.op}`);
      if (expr.args && !Array.isArray(expr.args)) throw new DataError('Expression args must be an array');
      for (const arg of expr.args ?? []) checkExpr(arg);
      if (['find', 'findMany'].includes(expr.op)) {
        if (
          !expr.match ||
          typeof expr.match !== 'object' ||
          Array.isArray(expr.match) ||
          !Object.keys(expr.match).length
        )
          throw new DataError('Plugin find requires explicit matching fields');
        for (const [key, value] of Object.entries(expr.match)) {
          safeName(key);
          checkExpr(value);
        }
      }
    }
  };
  const pluginIds = new Set();
  for (const p of result.plugins) {
    if (!p.entity) throw new DataError('Plugin requires entity');
    if (p.id) {
      if (pluginIds.has(p.id)) throw new DataError(`Duplicate plugin id ${p.id}`);
      pluginIds.add(p.id);
    }
    if (p.operations && !Array.isArray(p.operations)) throw new DataError('Plugin operations must be an array');
    for (const op of p.operations ?? [])
      if (!['create', 'update', 'delete'].includes(op)) throw new DataError(`Unknown plugin operation ${op}`);
    if (p.when) compileFilter(p.when);
    if (p.validate && !Array.isArray(p.validate)) throw new DataError('Plugin validate must be an array');
    for (const v of p.validate ?? []) {
      if (v.pattern) new RegExp(v.pattern);
      if (v.assert) compileFilter(v.assert);
      if (v.field) safeName(v.field);
      // Dataverse reports plugin exceptions as ISV aborted (0x80040265) unless
      // the simulated plugin names the platform error it reproduces.
      if (v.innerCode != null && !/^0x[0-9a-f]{8}$/i.test(String(v.innerCode)))
        throw new DataError('Plugin validation innerCode must be a 0x-prefixed 8-digit hex code');
    }
    for (const bag of [p.defaults, p.set])
      for (const [key, expr] of Object.entries(bag ?? {})) {
        safeName(key);
        checkExpr(expr);
      }
    if (p.secondary && !Array.isArray(p.secondary)) throw new DataError('Plugin secondary must be an array');
    for (const action of p.secondary ?? []) {
      if (action.requireMatch != null && typeof action.requireMatch !== 'boolean')
        throw new DataError('Secondary requireMatch must be a boolean');
      if (action.foreach) checkExpr(action.foreach);
      if (!action.entity || !['create', 'update', 'delete'].includes(action.operation))
        throw new DataError('Secondary action requires entity and create/update/delete operation');
      if (action.operation !== 'create' && !action.match) throw new DataError('Secondary update/delete requires match');
      for (const bag of [action.match, action.set])
        for (const [key, expr] of Object.entries(bag ?? {})) {
          safeName(key);
          checkExpr(expr);
        }
    }
  }
  return reconcilePermissionDiagnostics(applyPlatformConfig(result, platform));
}

// Temporary record directories of stores without a state file, by directory.
// closeRecordStorage() removes an entry; process exit removes what remains.
const temporaryRecordDirectories = new Map();
const ownedTemporaryRecordDirectory = (directory) =>
  dirname(directory) === fsSync.realpathSync.native(tmpdir()) &&
  basename(directory).startsWith('paqvilo-record-state-');
function removeTemporaryRecordDirectories() {
  for (const [directory, session] of temporaryRecordDirectories)
    try {
      session.deref()?.close();
      if (ownedTemporaryRecordDirectory(directory)) fsSync.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort: the process is exiting and an open handle keeps the files.
    }
  temporaryRecordDirectories.clear();
}

function traceRetentionError(original, persistence) {
  const failure = new AggregateError([original, persistence], persistence.message, { cause: original });
  failure.code = persistence.code ?? 'PluginTracePersistenceFailed';
  failure.status = failure.statusCode = persistence.status ?? persistence.statusCode ?? 500;
  failure.persistenceFailure = true;
  return failure;
}

export class DataStore {
  static {
    for (const name of storeOperationFields)
      Object.defineProperty(this.prototype, name, {
        configurable: true,
        get() {
          assertPluginExecutionActive(this);
          return storeOperationValue(this, name);
        },
        set(value) {
          assertPluginExecutionActive(this);
          setStoreOperationValue(this, name, value);
        },
      });
  }
  hasOperationContext() {
    return hasStoreOperationContext(this);
  }
  withOperationContext(fn, options) {
    assertPluginExecutionActive(this);
    return withStoreOperationContext(this, fn, options);
  }
  constructor({
    file = null,
    state = emptyState(),
    presetLibrary = builtinPresets,
    platform = state?.simulator?.platformDefaults,
    persistence,
    storageAdapter = null,
    clock = systemClock,
    ids = systemIds,
    unpublished = false,
    ownedState = false,
  } = {}) {
    this.file = file;
    // The record pipeline's time and GUID source (runtime-clock.mjs); createOrganizationRuntime shares it with its API.
    this.clock = clock;
    this.ids = ids;
    this.unpublished = unpublished;
    this.presetLibrary = presetLibrary;
    this.platformConfig = platformConfig(platform);
    // Hosts can adopt an already-detached composition result. Ordinary callers
    // retain the constructor's detached-input contract.
    this.state = normalizeState(state, this.presetLibrary, this.platformConfig, ownedState);
    this.persistedDigest = null;
    this.persistenceOptions = persistence;
    this.storageAdapter = storageAdapter;
    this.storage = file ? new StateStorage(file, persistence) : null;
    this.queue = Promise.resolve();
    // Advances with every committed change (transact), so consumers such as OData
    // paging can bind to the data without digesting the whole state per request.
    this.revision = 0;
    this.isolatedCount = 0;
  }
  // Only isolated transactions (see transact) divert reads and writes of `state` to
  // a private working copy, and only inside their own async context. Everything else
  // reads and writes the committed copy, so the default path is unchanged.
  get state() {
    assertPluginExecutionActive(this);
    if (this.isolatedCount) {
      const frame = transactionFrameOf(this);
      if (frame?.store === this && frame.working) return frame.working;
    }
    return this._state;
  }
  set state(value) {
    assertPluginExecutionActive(this);
    const frame = this.isolatedCount ? transactionFrameOf(this) : undefined;
    if (frame?.store === this && frame.working) frame.working = value;
    else this._state = value;
  }
  /**
   * A key that changes whenever the data a query reads may have changed: committed
   * store changes and a new site-table provider value (a reloaded portal).
   */
  dataRevision() {
    const site = this.virtualTables?.() ?? null;
    if (site !== this.siteTablesSeen) {
      this.siteTablesSeen = site;
      this.siteRevision = (this.siteRevision ?? 0) + 1;
    }
    return `${this.revision}.${this.siteRevision ?? 0}`;
  }
  /**
   * A key that changes whenever a commit may have changed one of `tables` (or the site tables, or the
   * state graph itself). Incremental row transactions name the tables they touched; any other commit
   * advances every table. Derived indexes (security) rebuild only when their own tables change.
   */
  tablesRevision(tables) {
    const site = this.dataRevision().split('.')[1];
    if (this.tablesStateSeen !== this.state) {
      this.tablesStateSeen = this.state;
      this.tableEpoch = (this.tableEpoch ?? 0) + 1;
    }
    let key = `${this.tableEpoch ?? 0}.${site}`;
    for (const table of tables) key += `.${this.tableRevisions?.get(table) ?? 0}`;
    return key;
  }
  /** Advance revision after a commit; `tables` names what an incremental commit touched (null: anything). */
  committed(tables = null) {
    this.revision++;
    if (tables === null) {
      this.tableEpoch = (this.tableEpoch ?? 0) + 1;
      return;
    }
    this.tableRevisions ??= new Map();
    for (const table of tables) this.tableRevisions.set(table, (this.tableRevisions.get(table) ?? 0) + 1);
  }
  async init({ restoredState, restoredStorage } = {}) {
    if (this.storageAdapter) {
      this.state = normalizeState(
        await this.storageAdapter.load(this.state),
        this.presetLibrary,
        this.platformConfig,
        true,
      );
      return this;
    }
    if (this.file) {
      this.ensureStorage();
      try {
        if (restoredState !== undefined) {
          if (!(restoredStorage instanceof StateStorage) || restoredStorage.file !== this.file)
            throw new TypeError('Restored state must use this file storage.');
          await restoredStorage.assertUnchanged();
          this.storage = restoredStorage;
        }
        this.state = normalizeState(
          restoredState ?? (await this.storage.load()),
          this.presetLibrary,
          this.platformConfig,
          true,
        );
        this.persistedDigest = this.storage.digest;
        if (this.storage.recordSession) this.recordSession = this.storage.recordSession;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.persistedDigest = null;
        await this.save();
      }
    }
    return this;
  }
  recordContext() {
    return { records: recordSources(() => this.ensureRecordSession()) };
  }
  ensureRecordSession() {
    if (!this.recordSession) {
      const directory = this.file
        ? resolve(this.file) + '.records'
        : fsSync.mkdtempSync(join(tmpdir(), 'paqvilo-record-state-'));
      this.recordSession = new RecordPageSession(directory, { stateOwner: this.file ?? undefined });
      if (!this.file) {
        this.temporaryRecordDirectory = this.recordSession.directory;
        if (!temporaryRecordDirectories.size) process.once('exit', removeTemporaryRecordDirectories);
        temporaryRecordDirectories.set(this.temporaryRecordDirectory, new WeakRef(this.recordSession));
      }
    }
    return this.recordSession;
  }
  closeRecordStorage() {
    clearInterval(this.recordRetirementTimer);
    this.recordRetirementTimer = null;
    const errors = [];
    for (const session of new Set([
      this.recordSession,
      this.storage?.recordSession,
      ...(this.retiredRecordSessions ?? []),
    ]))
      try {
        session?.close();
      } catch (error) {
        errors.push(error);
      }
    // Retain every owner for a retry and keep temporary files while any handle
    // failed to close. One failure must not strand later sessions and leases.
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Record storage sessions failed to close');
    this.retiredRecordSessions?.clear();
    this.recordSession = null;
    if (this.temporaryRecordDirectory) {
      const directory = this.temporaryRecordDirectory;
      if (!ownedTemporaryRecordDirectory(directory))
        throw Error('Temporary record directory is outside its owned root');
      fsSync.rmSync(directory, { recursive: true, force: true });
      this.temporaryRecordDirectory = null;
      temporaryRecordDirectories.delete(directory);
      if (!temporaryRecordDirectories.size) process.off('exit', removeTemporaryRecordDirectories);
    }
  }
  /** Release record pages and remove a temporary record directory (closeRecordStorage). */
  close() {
    this.closeRecordStorage();
  }
  /**
   * Run `fn(lease)` once earlier transactions settle; no transaction starts until
   * it does. A transaction requested meanwhile first calls `lease.onContention()`
   * once, synchronously, so `fn` can copy what it still reads from live state
   * and settle; `lease.contended` is already true if that request preceded `fn`.
   */
  readLease(fn) {
    const lease = { contended: false, onContention: null };
    (this.readLeases ??= new Set()).add(lease);
    const run = this.queue.then(() => fn(lease)).finally(() => this.readLeases.delete(lease));
    this.queue = run.catch(() => {});
    return run;
  }
  contendReadLeases() {
    for (const lease of this.readLeases ?? [])
      if (!lease.contended) {
        lease.contended = true;
        lease.onContention?.();
      }
  }
  /**
   * Stream a detached, consistent JSON export to `consume(chunks)` (an iterable of
   * strings) without a second copy of plain tables. Sections are copied and paged
   * tables forked; plain rows are encoded in place under a read lease. A
   * transaction requested meanwhile first copies the rows not yet encoded, then
   * runs while the export continues from that copy. `adjust(sections)` may edit
   * the copied sections; `project` is the jsonChunks projection.
   */
  exportState(consume, { adjust, project } = {}) {
    let writing;
    return this.readLease(async (lease) => {
      const { tables = {}, ...rest } = this.state,
        sections = cloneStateData(rest, { forkTables: true }),
        order = Object.keys(this.state),
        sources = Object.entries(tables).map(([name, rows]) => ({
          name,
          rows: pagedRecordsOf(rows) ? pagedRecordsOf(rows).fork() : rows,
          live: !pagedRecordsOf(rows),
          offset: 0,
        }));
      (this.snapshotRevisions ??= new WeakMap()).set(sections, this.revision);
      adjust?.(sections);
      let table = 0,
        row = 0,
        failure = null;
      // Copy every row not yet encoded: the rest of the current table and all later ones.
      const detach = () => {
        for (let index = table; index < sources.length; index++) {
          const source = sources[index];
          if (!source.live) continue;
          const from = index === table ? row : 0;
          source.rows = cloneStateData(source.rows.slice(from));
          source.offset = from;
          source.live = false;
        }
      };
      const options = project ? { project } : {};
      function* chunks() {
        let text = '{',
          first = true;
        // A copy that failed during contention ends the export at its next chunk.
        const flush = function* () {
          yield text;
          text = '';
          if (failure) throw failure;
        };
        const append = function* (encoded) {
          for (const chunk of encoded) {
            text += chunk;
            if (text.length >= 65536) yield* flush();
          }
        };
        const member = function* (key, value) {
          const encoded = jsonChunks(value, options),
            head = encoded.next();
          // A section that encodes to nothing (undefined) is omitted, as in JSON.
          if (head.done) return;
          text += (first ? '' : ',') + JSON.stringify(key) + ':';
          first = false;
          yield* append([head.value]);
          yield* append(encoded);
        };
        for (const key of order) {
          if (key !== 'tables') {
            if (Object.hasOwn(sections, key)) yield* member(key, sections[key]);
            continue;
          }
          text += (first ? '' : ',') + '"tables":{';
          first = false;
          for (table = 0; table < sources.length; table++) {
            const source = sources[table];
            text += (table ? ',' : '') + JSON.stringify(source.name) + ':';
            if (pagedRecordsOf(source.rows)) yield* append(jsonChunks(source.rows, options));
            else {
              const length = source.offset + source.rows.length;
              text += '[';
              for (row = 0; row < length; row++) {
                text +=
                  (row ? ',' : '') + ([...jsonChunks(source.rows[row - source.offset], options)].join('') || 'null');
                if (text.length >= 65536) yield* flush();
              }
              text += ']';
            }
          }
          table = sources.length;
          text += '}';
        }
        yield text + '}';
      }
      let released;
      const contention = new Promise((resolve) => (released = resolve));
      lease.onContention = () => {
        // The requesting transaction is unrelated to this export and never sees its failure.
        try {
          detach();
        } catch (error) {
          failure = error;
        }
        released();
      };
      if (lease.contended) lease.onContention();
      writing = consume(chunks());
      await Promise.race([writing, contention]);
    }).then(() => writing);
  }
  snapshot(projection, options) {
    if (projection === undefined) {
      const snapshot = cloneStateData(this.state, options);
      (this.snapshotRevisions ??= new WeakMap()).set(snapshot, this.revision);
      return snapshot;
    }
    const snapshot = cloneStateData(this.projectionOf(projection), options);
    (this.snapshotRevisions ??= new WeakMap()).set(snapshot, this.revision);
    return snapshot;
  }
  /** The live (uncopied) sections, tables and mappings a snapshot projection names. Callers must not mutate it. */
  projectionOf(projection) {
    if (!projection || typeof projection !== 'object' || Array.isArray(projection))
      throw new DataError('Snapshot projection must name sections, tables or mappings');
    const selected = {};
    for (const [kind, names] of Object.entries(projection)) {
      if (!['sections', 'tables', 'mappings'].includes(kind) || !Array.isArray(names))
        throw new DataError('Invalid snapshot projection');
      for (const name of names) {
        safeName(name);
        if (kind === 'sections') {
          if (own(this.state, name)) selected[name] = this.state[name];
        } else {
          selected[kind] ??= {};
          if (own(this.state[kind], name)) selected[kind][name] = this.state[kind][name];
        }
      }
    }
    return selected;
  }
  // Provenance is local to this store and never serialized into state files.
  snapshotRevision(snapshot) {
    return this.snapshotRevisions?.get(snapshot);
  }
  snapshotDigest() {
    return stateDigest(this.state);
  }
  summary() {
    const selected = this.snapshot({
      sections: ['version', 'settings', 'simulator', 'mappings', 'permissions', 'plugins'],
      tables: ['contact'],
    });
    selected.presets = Object.fromEntries(
      Object.entries(this.state.presets ?? {}).map(([id, preset]) => [
        id,
        {
          name: preset.name,
          description: preset.description,
          userConfigured: preset.userConfigured,
          builtin: preset.builtin,
          builtinVersion: preset.builtinVersion,
          configurationPreset: preset.configurationPreset,
        },
      ]),
    );
    selected.tableCounts = Object.fromEntries(
      Object.entries(this.state.tables ?? {}).map(([name, rows]) => [name, rows.length]),
    );
    return selected;
  }
  async save() {
    assertPluginExecutionActive(this);
    const frame = transactionFrameOf(this);
    if (frame?.store === this && frame.initializing && !frame.closed && !frame.committing) return;
    try {
      return await this.#saveState();
    } catch (error) {
      // A failed publication is never a business rejection. In particular it
      // must not retry and retain elastic/independent writes in the catch path.
      if (error && typeof error === 'object' && Object.isExtensible(error)) {
        error.persistenceFailure = true;
        throw error;
      }
      throw Object.assign(new Error(error?.message ?? String(error), { cause: error }), { persistenceFailure: true });
    }
  }
  async #saveState(selectedState = this.state) {
    if (this.storageAdapter) {
      const started = performance.now();
      // An unpromoted row transaction names the tables it wrote, so the adapter rehashes only those.
      await this.storageAdapter.save(
        selectedState,
        this.rowTransaction && !this.rowTransaction.promoted ? { tables: this.rowTransaction.touchedTables() } : {},
      );
      this.recordSave(performance.now() - started, 'simulation');
      return;
    }
    if (!this.file) return;
    this.ensureStorage();
    const saveStarted = performance.now();
    await mkdir(dirname(this.file), { recursive: true });
    const intendedRecords = resolve(this.file) + '.records';
    const recordDirectory = fsSync.existsSync(intendedRecords)
      ? fsSync.realpathSync.native(intendedRecords)
      : join(fsSync.realpathSync.native(dirname(intendedRecords)), basename(intendedRecords));
    // A store that created pages before a state file was bound (an in-memory
    // session) moves them next to the file on its first save.
    if (this.recordSession && this.recordSession.directory !== recordDirectory) {
      await this.storage.assertUnchanged();
      const migrated = await compactRecordGraph(selectedState, recordDirectory, { stateOwner: this.file });
      if (!migrated) {
        // No published table uses the foreign session. Later tables start in
        // the file's own directory instead of being migrated on every save.
        (this.retiredRecordSessions ??= new Set()).add(this.recordSession);
        this.recordSession = null;
        this.scheduleRecordRetirement();
      } else {
        const previous = this.recordSession;
        // Point the manager at its unpublished destination for this recursive
        // save; the state graph itself remains on the preceding live pages.
        this.recordSession = migrated.session;
        let published = false;
        try {
          await this.#saveState(migrated.state);
          published = migrated.publish();
          if (published) {
            this.storage.recordSession = migrated.session;
            (this.retiredRecordSessions ??= new Set()).add(previous);
            this.scheduleRecordRetirement();
            return;
          }
        } finally {
          if (!published) {
            this.recordSession = previous;
            migrated.session.close();
          }
        }
        // Records changed while the copy was saved: copy the live tables again.
        return this.#saveState(selectedState);
      }
    }
    const lockPath = `${this.file}.lock`,
      lockToken = `${process.pid}:${randomUUID()}`,
      temp = `${this.file}.${randomUUID()}.tmp`;
    let lockHandle;
    let writeFailed = false;
    let writeFailure;
    let cleanupFailure;
    try {
      await (async () => {
        try {
          lockHandle = await open(lockPath, 'wx', 0o600);
        } catch (error) {
          if (error.code === 'EEXIST')
            throw new DataError(
              'Local state is being written by another process; retry after it finishes',
              409,
              'StateConflict',
            );
          throw error;
        }
        await lockHandle.writeFile(`${lockToken}\n`);
        await lockHandle.close();
        lockHandle = null;

        await this.storage.assertUnchanged();
        const initialization = transactionFrameOf(this);
        if (
          this.storage.journal &&
          this.storage.canAppend(selectedState) &&
          initialization?.store === this &&
          !initialization.closed &&
          initialization.initializationDelta
        ) {
          await this.storage.appendChanges(initializationEntries(initialization.initializationDelta), {
            state: selectedState,
          });
          this.persistedDigest = this.storage.digest;
          this.recordSave(performance.now() - saveStarted, 'journal');
          return;
        }
        if (this.storage.journal && this.storage.canAppend(selectedState) && this.rowTransaction) {
          await this.storage.appendChanges(this.rowTransaction.changes(), { state: selectedState });
          this.persistedDigest = this.storage.digest;
          this.recordSave(performance.now() - saveStarted, 'journal');
          return;
        }
        const prepared = await this.storage.prepareCheckpoint(temp, selectedState);
        // Recheck immediately before replacement to catch non-cooperating edits
        // made while the temporary snapshot was being prepared.
        await this.storage.assertUnchanged();
        await rename(temp, this.file);
        await this.storage.checkpointCommitted(prepared);
        this.persistedDigest = this.storage.digest;
        this.recordSave(performance.now() - saveStarted, 'checkpoint');
      })();
    } catch (error) {
      writeFailed = true;
      writeFailure = error;
    } finally {
      if (lockHandle) await lockHandle.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
      // Remove only the lock this save created. Never infer staleness or
      // delete a lock owned by another process.
      try {
        if ((await readFile(lockPath, 'utf8')) === `${lockToken}\n`) await unlink(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') cleanupFailure = error;
      }
    }
    if (writeFailed && cleanupFailure) {
      throw new AggregateError([writeFailure, cleanupFailure], 'Local state save and lock cleanup failed', {
        cause: writeFailure,
      });
    }
    if (writeFailed) throw writeFailure;
    if (cleanupFailure) throw cleanupFailure;
  }
  recordSave(durationMs, mode) {
    this.lastSave = { durationMs: Math.round(durationMs * 100) / 100, mode };
    // Observers cannot turn a durable commit into a rolled-back request.
    try {
      this.onSave?.({ ...this.lastSave });
    } catch {
      /* observer only */
    }
  }
  ensureStorage() {
    // An embedded store may bind a file after starting in memory; never keep the CAS of another file.
    if (!this.storage || this.storage.file !== this.file) {
      this.storage = new StateStorage(this.file, this.persistenceOptions);
      this.persistedDigest = null;
    }
  }
  digest(raw) {
    return createHash('sha256').update(raw).digest('hex');
  }
  async readPersistedDigest() {
    this.ensureStorage();
    return this.storage.persistedDigest();
  }
  /** Serialize reads that may invoke backend plugin writes. Pure reads do not
   * change the persisted state or its revision. Invoke this only at a request
   * boundary; nested SDK reads already use their caller's synchronous frame. */
  readOperation(fn) {
    return this.transact(fn, { skipSaveIfUnchanged: true, cloneResult: false, lazyReadSnapshot: true });
  }
  /** Only a host-owned store with no published readers may initialize in place.
   * Nested saves are deferred; a failed stage discards this store and leaves its
   * durable checkpoint authoritative. Public transactions retain isolation. */
  initialize(fn) {
    if (!this.unpublished || this.initializationFailed)
      throw new Error('Private initialization requires an unpublished, usable store.');
    return this.transact(fn, {
      isolated: true,
      cloneResult: false,
      skipSaveIfUnchanged: true,
      privateInitialization: !this.storageAdapter,
    });
  }
  isInitializing() {
    const frame = transactionFrameOf(this);
    return frame?.store === this && frame.initializing && !frame.closed;
  }
  completeInitialization() {
    this.unpublished = false;
    this.initializationFingerprintCache = null;
  }
  // A read hook that may run arbitrary plug-in code first captures its rollback
  // snapshot. Metadata consumers may reuse read inputs only before that point.
  isUnmodifiedRead() {
    const frame = transactionFrameOf(this),
      boundary = this.pluginRollbackBoundary;
    return (
      frame?.store === this &&
      !frame.closed &&
      typeof boundary?.ensureSnapshot === 'function' &&
      boundary.backup === null
    );
  }
  /** True inside an open transaction of this store in this async context: a new transact here would queue behind it. */
  inTransaction() {
    const frame = transactionFrameOf(this);
    return frame?.store === this && !frame.closed;
  }
  ensureReadSnapshot() {
    this.promoteRowTransaction();
    this.pluginRollbackBoundary?.ensureSnapshot?.();
  }
  promoteRowTransaction() {
    if (!this.rowTransaction) return;
    const transaction = this.rowTransaction;
    this.pluginRollbackBoundary.backup = transaction.rollback(cloneInternal(this.state));
    this.pluginRollbackBoundary.persistenceBackup ??= this.pluginRollbackBoundary.backup;
    transaction.promoted = true;
    this.rowTransaction = null;
  }
  /**
   * `nested: true` joins the transaction this store already runs in the same async
   * context (no snapshot, commit, persist or event dispatch of its own); outside one
   * it is a normal transaction. A plain call inside an open isolated transaction joins
   * it the same way. `isolated: true` keeps the changes private to the
   * async context until the commit, so concurrent readers see the committed state.
   */
  transact(
    fn,
    {
      skipSaveIfUnchanged = false,
      cloneResult = true,
      lazyReadSnapshot = false,
      incremental = false,
      nested = false,
      isolated = false,
      privateInitialization = false,
    } = {},
  ) {
    // ponytail: a nested throw that the caller catches keeps that call's partial writes;
    // only the outermost transaction rolls back.
    // A frame that has finished (closed) no longer joins: its async continuations run later.
    // Inside an open isolated changeset a plain transact joins it too: every write made while
    // the changeset runs belongs to that changeset (Dataverse changesets are atomic).
    assertPluginExecutionActive(this);
    const active = transactionFrameOf(this);
    if ((nested || active?.working) && active?.store === this && !active.closed)
      return (async () => {
        const result = await fn();
        return cloneResult ? clone(result) : result;
      })();
    if (privateInitialization && (!this.unpublished || this.initializationFailed))
      throw new Error('Private initialization requires an unpublished, usable store.');
    this.contendReadLeases();
    const frame = { store: this, working: null, initializing: privateInitialization };
    const run = this.queue.then(() =>
      this.withOperationContext(
        async () => {
          assertPluginExecutionActive(this);
          let initializationDigest = null;
          try {
            if (privateInitialization && this.file)
              initializationDigest = this.storage?.journal
                ? this.initializationFingerprintCache?.file === this.file &&
                  this.initializationFingerprintCache.digest === this.persistedDigest
                  ? this.initializationFingerprintCache.value
                  : await initializationFingerprint(this._state)
                : stateDigest(this._state, { sortKeys: true });
          } catch (error) {
            frame.closed = true;
            this.initializationFailed = true;
            this.unpublished = false;
            this._state = emptyState();
            this.initializationFingerprintCache = null;
            throw error;
          }
          frame.parent = transactionFrames.getStore();
          transactionFrames.enterWith(frame);
          // ponytail: an isolated transaction works on a full clone of the committed state
          // and publishes it at commit. It is O(state) per changeset, a write that bypasses
          // transact is lost at commit, and an independent plugin commit inside it persists
          // the working copy. Use a change overlay before batch relies on any of these.
          if (isolated) frame.working = privateInitialization ? this._state : cloneInternal(this._state);
          // Arbitrary extension callbacks retain the established full rollback
          // boundary. Core CRUD/declarative handlers use the bounded undo journal.
          const rowTransaction = incremental ? new RowTransaction(this, { reuse: !isolated }) : null;
          const previousRows = this.rowTransaction;
          this.rowTransaction = rowTransaction;
          const boundary = {
            // The committed graph is already the rollback copy of an isolated
            // working graph. A second whole-state clone cannot improve isolation.
            backup: privateInitialization
              ? null
              : isolated
                ? this._state
                : lazyReadSnapshot || rowTransaction
                  ? null
                  : cloneInternal(this.state),
            independentCommit: false,
            eventCount: 0,
          };
          boundary.persistenceBackup = boundary.backup;
          if (lazyReadSnapshot)
            boundary.ensureSnapshot = () => {
              if (boundary.backup !== null) return;
              boundary.backup = cloneInternal(this.state);
              boundary.persistenceBackup = boundary.backup;
            };
          const previousBoundary = this.pluginRollbackBoundary,
            previousTransaction = this.pluginInTransaction;
          boundary.parent = previousBoundary;
          const previousEvents = this.committedEventCandidates;
          this.committedEventCandidates = [];
          this.pluginRollbackBoundary = boundary;
          this.pluginInTransaction = isolated;
          try {
            if (isolated) this.isolatedCount = (this.isolatedCount ?? 0) + 1;
            const result = await fn();
            if (boundary.transactionFailure) throw boundary.transactionFailure;
            this.restorePluginTraceLogs(boundary);
            const staged = this.stageOnCommit(this.committedEventCandidates);
            const journalInitialization = initializationDigest && typeof initializationDigest === 'object';
            if (journalInitialization) {
              const delta = await initializationDelta(initializationDigest, this.state);
              frame.initializationDelta = delta.changes;
              frame.initializationFingerprint = delta.fingerprint;
            }
            if (
              staged.length ||
              !skipSaveIfUnchanged ||
              boundary.independentCommit ||
              (privateInitialization &&
                (initializationDigest === null ||
                  (journalInitialization
                    ? frame.initializationDelta.length > 0
                    : stateDigest(this.state, { sortKeys: true }) !== initializationDigest))) ||
              (boundary.backup !== null && !privateRecordEqual(this.state, boundary.backup))
            ) {
              frame.committing = true;
              await this.save();
              this.committed(
                rowTransaction && !rowTransaction.promoted && !isolated ? rowTransaction.touchedTables() : null,
              );
              // Section copies the journal commit proved unchanged seed the next row transaction (RowTransaction reuse).
              const reusable = rowTransaction && !isolated ? rowTransaction.reusableSections() : null;
              if (reusable) this.sectionSnapshot = { ...reusable, revision: this.revision };
            } else if (privateInitialization && this.file) await this.storage.assertUnchanged();
            if (isolated) this._state = frame.working;
            if (journalInitialization)
              this.initializationFingerprintCache = {
                file: this.file,
                digest: this.persistedDigest,
                value: frame.initializationFingerprint,
              };
            this.dispatchCommittedEvents(this.committedEventCandidates);
            this.afterStagedCommit(staged);
            for (const note of boundary.commitNotes ?? [])
              try {
                note();
              } catch {
                /* a note never changes the outcome */
              }
            // Read query results own their projection and may carry nonenumerable
            // SDK/paging/column metadata required by the transport adapter.
            return cloneResult ? clone(result) : result;
          } catch (error) {
            if (!rowTransaction?.promoted) rowTransaction?.rollback();
            this.rowIndexes = null;
            const rollback = error.persistenceFailure ? boundary.persistenceBackup : boundary.backup;
            if (!privateInitialization && rollback !== null) this.state = cloneInternal(rollback);
            for (const note of boundary.rollbackNotes ?? [])
              try {
                note(error);
              } catch {
                /* a note never changes the failure */
              }
            if (privateInitialization) {
              this.initializationFailed = true;
              this.unpublished = false;
              this._state = emptyState();
              this.initializationFingerprintCache = null;
              throw error;
            }
            // Trace facts are platform diagnostics, not business writes. Their own
            // failed transaction journal must never replay aborted target changes.
            const traceRetentionBackup = boundary.pluginTraceRows?.size ? cloneInternal(this.state) : null;
            if (traceRetentionBackup) this.rowTransaction = null;
            const retainedTraces = !error.persistenceFailure && this.restorePluginTraceLogs(boundary);
            // Elastic main operations commit independently, even inside a failed changeset or a failed PostOperation.
            // Restore only those rows after rollback: earlier standard-table writes remain transactional.
            if (!error.persistenceFailure && boundary.elasticWrites?.size) {
              const retentionBackup = cloneInternal(this.state);
              try {
                for (const { mapping, row, removed } of boundary.elasticWrites.values()) {
                  const rows = (this.state.tables[mapping.logicalName] ??= []);
                  const index = this.rowIndex(mapping, rows, recordKey(mapping, row));
                  if (removed) {
                    if (index >= 0) rows.splice(index, 1);
                  } else if (index >= 0) rows[index] = clone(row);
                  else rows.push(clone(row));
                }
                this.state.rowVersion = Math.max(this.state.rowVersion ?? 0, boundary.elasticVersion ?? 0);
                const retained =
                  boundary.independentCommit && !isolated
                    ? this.committedEventCandidates.slice(0, boundary.eventCount)
                    : [];
                const events = [...new Set([...retained, ...(boundary.elasticEvents ?? [])])],
                  staged = this.stageOnCommit(events);
                await this.save();
                this.committed();
                if (isolated) this._state = frame.working;
                this.dispatchCommittedEvents(events);
                this.afterStagedCommit(staged);
              } catch (saveError) {
                this.state = boundary.persistenceBackup ?? traceRetentionBackup ?? retentionBackup;
                this.rowIndexes = null;
                if (traceRetentionBackup) throw traceRetentionError(error, saveError);
                throw saveError;
              }
            } else if (!error.persistenceFailure && ((boundary.independentCommit && !isolated) || retainedTraces)) {
              try {
                const events =
                    boundary.independentCommit && !isolated
                      ? this.committedEventCandidates.slice(0, boundary.eventCount)
                      : [],
                  staged = this.stageOnCommit(events);
                await this.save();
                this.committed();
                if (isolated) this._state = frame.working;
                this.dispatchCommittedEvents(events);
                this.afterStagedCommit(staged);
              } catch (saveError) {
                if (boundary.persistenceBackup !== null) this.state = boundary.persistenceBackup;
                else if (traceRetentionBackup) this.state = traceRetentionBackup;
                this.rowIndexes = null;
                if (traceRetentionBackup) throw traceRetentionError(error, saveError);
                throw saveError;
              }
            }
            throw error;
          } finally {
            if (rowTransaction?.promoted || (!rowTransaction && (!skipSaveIfUnchanged || boundary.backup !== null)))
              this.rowIndexes = null;
            this.rowTransaction = previousRows;
            this.pluginRollbackBoundary = previousBoundary;
            this.pluginInTransaction = previousTransaction;
            this.committedEventCandidates = previousEvents;
            if (isolated) this.isolatedCount -= 1;
            frame.closed = true;
            frame.working = null;
            frame.initializationDelta = null;
            frame.initializationFingerprint = null;
          }
        },
        { fresh: true },
      ),
    );
    this.queue = run.catch(() => {});
    return run;
  }
  /** Rewrite a streamed checkpoint without copying the in-memory state. Queued
   * with writes; call during an idle period to bound append-journal disk usage. */
  compact() {
    this.contendReadLeases();
    const run = this.queue.then(async () => {
      const oldSession = this.recordSession ?? this.storage?.recordSession;
      if (!oldSession) return this.save();
      const compacted = await compactRecordGraph(this.state, oldSession.directory, oldSession.ownerKey);
      if (!compacted) return this.save();
      let published = false;
      try {
        await this.#saveState(compacted.state);
        // Records changed while the checkpoint was written: keep and persist the live tables.
        if (!compacted.publish()) return await this.#saveState();
        published = true;
        this.recordSession = compacted.session;
        if (this.storage) this.storage.recordSession = compacted.session;
        this.sectionSnapshot = null;
        this.initializationFingerprintCache = null;
        (this.retiredRecordSessions ??= new Set()).add(oldSession);
        this.scheduleRecordRetirement();
        await this.collectRecordStorage();
      } finally {
        if (!published) {
          compacted.session.close();
          await this.collectRecordStorage();
        }
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
  retireRecordSessions() {
    for (const session of this.retiredRecordSessions ?? []) {
      if (session.hasLiveTables()) continue;
      try {
        session.close();
        this.retiredRecordSessions.delete(session);
      } catch (error) {
        this.recordCleanupError = error;
      }
    }
    if (!this.retiredRecordSessions?.size) {
      clearInterval(this.recordRetirementTimer);
      this.recordRetirementTimer = null;
    }
  }
  /** Close retired sessions now; recheck the ones that still back live tables
   * every 2 s (without holding the process open) until none remain. */
  scheduleRecordRetirement() {
    this.retireRecordSessions();
    if (!this.retiredRecordSessions?.size || this.recordRetirementTimer) return;
    this.recordRetirementTimer = setInterval(() => this.retireRecordSessions(), 2000);
    this.recordRetirementTimer.unref();
  }
  async collectRecordStorage() {
    const session = this.recordSession;
    if (!session?.ownedDirectory) return (this.recordGarbageCollection = { skipped: 'unverified-directory' });
    if (this.file) {
      const intended = resolve(this.file) + '.records';
      if (fsSync.lstatSync(intended).isSymbolicLink() || fsSync.realpathSync.native(intended) !== session.directory)
        return { skipped: 'directory-identity' };
    }
    const lockPath = this.file ? this.file + '.lock' : null,
      token = `${process.pid}:${randomUUID()}\n`;
    let lock;
    try {
      if (lockPath) {
        try {
          lock = await open(lockPath, 'wx', 0o600);
        } catch (error) {
          if (error.code === 'EEXIST') return { skipped: 'active-writer' };
          throw error;
        }
        await lock.writeFile(token);
        await lock.close();
        lock = null;
        await this.storage.assertUnchanged();
      }
      const encoded = encodeRecordReferences({ op: 'section', key: 'state', value: this.state });
      const published = new Set(
        (encoded.recordRefs ?? []).flatMap((reference) => reference.table.files.map((file) => file.name)),
      );
      this.recordGarbageCollection = await collectRecordGarbage(session.directory, published);
      return this.recordGarbageCollection;
    } catch (error) {
      // Collection follows a committed checkpoint. Its failure must not turn a
      // successful publication into a business rollback against newer disk data.
      this.recordCleanupError = error;
      return { skipped: 'collection-failed', code: error.code ?? 'RecordCleanup' };
    } finally {
      await lock?.close().catch(() => {});
      if (lockPath)
        try {
          if ((await readFile(lockPath, 'utf8')) === token) await unlink(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') this.recordCleanupError = error;
        }
    }
  }
  // Row writes go through writeRow/mutateRow/insertRow/removeRow, which keep every cached
  // row index of that array (rowIndexes: rows -> Map<name, RowKeyIndex>) current.
  writeRow(table, rows, index, row) {
    validateRowIndex(rows, index);
    const indexes = this.rowIndexes?.get(rows),
      previous = indexes?.size ? rows[index] : undefined;
    if (this.rowTransaction) this.rowTransaction.set(table, rows, index, row);
    else Object.defineProperty(rows, index, { value: row, enumerable: true, configurable: true, writable: true });
    if (indexes?.size)
      for (const [name, entry] of indexes) if (!entry.moved(rows, index, previous, row)) indexes.delete(name);
  }
  mutateRow(table, rows, index, values) {
    assertPluginExecutionActive(this);
    validateRowIndex(rows, index);
    const indexes = this.rowIndexes?.get(rows),
      keys = indexes?.size ? [...indexes].map(([name, entry]) => [name, entry, entry.keyOf(rows[index])]) : null;
    if (this.rowTransaction) this.rowTransaction.mutate(table, rows, index, values);
    else assignRowValues(rows.at(index), values);
    for (const [name, entry, previous] of keys ?? [])
      if (!entry.moved(rows, index, null, rows[index], previous)) indexes.delete(name);
  }
  insertRow(table, rows, row) {
    assertPluginExecutionActive(this);
    if (this.rowTransaction) this.rowTransaction.insert(table, rows, rows.length, row);
    else rows.push(row);
    const indexes = this.rowIndexes?.get(rows);
    if (indexes?.size) for (const [name, entry] of indexes) if (!entry.appended(rows, row)) indexes.delete(name);
  }
  /** System-owned plug-in trace facts survive a business rollback. Never retain another table this way. */
  appendPluginTraceLog(row) {
    this.insertRow('plugintracelog', (this.state.tables.plugintracelog ??= []), row);
    let boundary = this.pluginRollbackBoundary;
    while (boundary?.parent) boundary = boundary.parent;
    if (boundary) (boundary.pluginTraceRows ??= new Map()).set(row.plugintracelogid, clone(row));
  }
  /** Reconcile diagnostic facts after a savepoint rollback without duplicating traces already in its snapshot. */
  restorePluginTraceLogs(boundary) {
    while (boundary?.parent) boundary = boundary.parent;
    if (!boundary?.pluginTraceRows?.size || !this.state.mappings?.plugintracelog) return false;
    const rows = (this.state.tables.plugintracelog ??= []),
      ids = new Set(rows.map((row) => row.plugintracelogid));
    let restored = false;
    for (const [id, row] of boundary.pluginTraceRows) {
      if (ids.has(id)) continue;
      this.insertRow('plugintracelog', rows, clone(row));
      ids.add(id);
      restored = true;
    }
    return restored;
  }
  removeRow(table, rows, index) {
    assertPluginExecutionActive(this);
    validateRowIndex(rows, index);
    const indexes = this.rowIndexes?.get(rows),
      removed = rows[index];
    if (this.rowTransaction) this.rowTransaction.remove(table, rows, index);
    else rows.splice(index, 1);
    if (indexes?.size)
      for (const [name, entry] of indexes) if (!entry.removed(rows, index, removed)) indexes.delete(name);
  }
  /**
   * The cached index `name` of a row array (see RowKeyIndex), built on first use and
   * rebuilt when the array length no longer matches. A `scoped` index lives only for the
   * current transaction frame, so direct row edits between transactions cannot leave it stale;
   * outside a transaction it returns null and callers scan.
   */
  rowKeyIndex(rows, name, keyOf, { scoped = false, wild = false } = {}) {
    let frame;
    if (scoped) {
      frame = transactionFrameOf(this);
      if (!frame || frame.store !== this || frame.closed) return null;
    }
    this.rowIndexes ??= new WeakMap();
    let indexes = this.rowIndexes.get(rows);
    if (!indexes) this.rowIndexes.set(rows, (indexes = new Map()));
    let entry = indexes.get(name);
    if (!entry || entry.length !== rows.length || entry.frame !== frame) {
      entry = new RowKeyIndex(rows, keyOf, { frame, wild });
      indexes.set(name, entry);
    }
    return entry;
  }
  /** Drop one cached index after a failed validity check, so the next lookup rebuilds it. */
  dropRowKeyIndex(rows, name) {
    this.rowIndexes?.get(rows)?.delete(name);
  }
  rowIndex(mapping, rows, id, options = {}) {
    if (isElastic(mapping)) {
      const key = typeof id === 'string' && id.includes('=') ? parseKeySegment(id) : null;
      const primary = key?.[mapping.idColumn] ?? id;
      const partition = key?.partitionid ?? options.partitionId ?? null;
      return rows.findIndex(
        (row) => equal(row[mapping.idColumn], primary) && samePartition(row.partitionid, partition),
      );
    }
    return this.rowPositions(mapping, rows, id)?.[0] ?? -1;
  }
  /**
   * Ascending positions of the rows whose primary key equals `id` (the store's coercive
   * equality), through the primary-key index; null-safe linear scan for non-string ids.
   */
  rowPositions(mapping, rows, id, { scoped = false } = {}) {
    const paged = pagedRecordsOf(rows)?.primaryPositions(mapping.idColumn, id);
    if (paged !== undefined && paged !== null) return paged;
    const column = mapping.idColumn,
      linear = () => rows.flatMap((row, index) => (equal(row[column], id) ? [index] : []));
    // Non-string identifiers keep the coercive comparison of the linear scan.
    if (typeof id !== 'string') return linear();
    // A scoped index (uniqueness checks) is rebuilt per transaction, so it never answers a stale miss across writes.
    const name = `${scoped ? 'uid' : 'id'}\u0000${column}`,
      key = comparable(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = this.rowKeyIndex(rows, name, primaryKeyOf(column), { scoped });
      if (!entry || entry.linear) return linear();
      const found = entry.get(key);
      // Validity check on hit: a position whose row no longer carries the key means the
      // array changed outside the row choke points; rebuild once.
      if (found.every((index) => rows[index] !== undefined && entry.keyOf(rows[index]) === key)) return found;
      this.dropRowKeyIndex(rows, name);
    }
    return linear();
  }
  /**
   * The stored rows of a local table whose primary key is one of `ids` (string ids), in table
   * order; null when the caller must scan (site/expiring tables, non-string keys).
   */
  primaryKeySubset(mapping, ids) {
    const rows = this.tableRows(mapping.logicalName);
    if (rows !== this.state.tables[mapping.logicalName] || !ids.every((id) => typeof id === 'string')) return null;
    if (
      !pagedRecordsOf(rows)?.keyTree &&
      this.rowKeyIndex(rows, `id\u0000${mapping.idColumn}`, primaryKeyOf(mapping.idColumn)).linear
    )
      return null;
    const positions = new Set();
    for (const id of ids) for (const position of this.rowPositions(mapping, rows, id)) positions.add(position);
    return [...positions].sort((a, b) => a - b).map((position) => rows[position]);
  }
  /** A synchronous SDK request has its own atomic write, unless its caller
   * already participates in the plugin transaction. Independent PreValidation
   * requests commit before a later primary-operation rejection. */
  sdkMutation(fn) {
    if (!this.hasOperationContext()) return this.withOperationContext(() => this.sdkMutation(fn));
    const savepoint = this.sdkSavepoint();
    try {
      const result = fn();
      savepoint.commit();
      return result;
    } catch (error) {
      savepoint.rollback();
      this.markPluginTransactionFailure(error);
      throw error;
    } finally {
      savepoint.close();
    }
  }
  /** sdkMutation for an SDK call on the asynchronous pipeline (a flow Dataverse action, data.mjs createRecordAsync): the
   * same savepoint, held until fn's promise settles. The caller runs inside the store's transaction queue (the flow run's
   * transaction), so no other write interleaves while the call awaits its I/O. */
  async sdkMutationAsync(fn) {
    if (!this.hasOperationContext()) return this.withOperationContext(() => this.sdkMutationAsync(fn));
    const savepoint = this.sdkSavepoint();
    try {
      const result = await fn();
      savepoint.commit();
      return result;
    } catch (error) {
      savepoint.rollback();
      this.markPluginTransactionFailure(error);
      throw error;
    } finally {
      savepoint.close();
    }
  }
  // One SDK call's savepoint (sdkMutation, sdkMutationAsync): commit, rollback, then close.
  sdkSavepoint() {
    assertPluginExecutionActive(this);
    this.assertPluginTransactionActive();
    this.ensureReadSnapshot();
    const joined = this.pluginInTransaction === true,
      previousBoundary = this.pluginRollbackBoundary,
      previousRows = this.rowTransaction;
    const pluginCaller = Boolean(this.pluginParentContext || pluginInvocationDepth(this) > 0);
    const previousFailures = [];
    if (!pluginCaller)
      for (let parent = previousBoundary; parent; parent = parent.parent)
        previousFailures.push([parent, parent.transactionFailure]);
    // A nested RowTransaction is the call's savepoint: it journals the call's row writes instead of copying the
    // whole state first. Handler code that may write arbitrary state promotes it (promoteRowTransaction), which
    // fills boundary.backup with the complete pre-call copy.
    const savepoint = new RowTransaction(this);
    const boundary = {
      backup: null,
      independentCommit: false,
      eventCount: this.committedEventCandidates?.length ?? 0,
      parent: previousBoundary,
    };
    this.pluginRollbackBoundary = boundary;
    this.rowTransaction = savepoint;
    return {
      commit: () => {
        this.assertPluginTransactionActive();
        this.rowTransaction = previousRows;
        if (!joined && previousBoundary) {
          previousBoundary.backup = cloneInternal(this.state);
          previousBoundary.independentCommit = true;
          previousBoundary.eventCount = this.committedEventCandidates?.length ?? 0;
        }
      },
      rollback: () => {
        this.rowTransaction = previousRows;
        // Keep table/row references held by an enclosing synchronous pipeline
        // intact while removing every failed request's transactional write.
        if (boundary.backup !== null) restoreInPlace(this.state, boundary.backup);
        else savepoint.rollback(this.state, restoreInPlace);
        this.rowIndexes = null;
        this.restorePluginTraceLogs(boundary);
        if (this.committedEventCandidates) this.committedEventCandidates.length = boundary.eventCount;
        // A service request initiated by a flow/connector can fail and be handled
        // by that caller. Its plug-in transaction failure belongs to this primary
        // request; a plug-in's own nested SDK call still poisons its active caller.
        for (const [parent, failure] of previousFailures) {
          if (failure === undefined) delete parent.transactionFailure;
          else parent.transactionFailure = failure;
        }
        if (!joined && boundary.independentCommit && previousBoundary) {
          previousBoundary.backup = cloneInternal(this.state);
          previousBoundary.independentCommit = true;
          previousBoundary.eventCount = boundary.eventCount;
        }
      },
      close: () => {
        this.pluginRollbackBoundary = previousBoundary;
        this.rowTransaction = previousRows;
      },
    };
  }
  /** A failed OrganizationService operation terminates its synchronous caller's
   * transaction. Savepoints retain rollback precision, but cannot make a caught
   * service fault into a successful outer operation. */
  markPluginTransactionFailure(cause) {
    if (cause?.code === 'LocalPluginExecutionExpired' || transactionFrameOf(this, { closed: true })?.closed) return;
    if (
      !this.pluginInTransaction ||
      !this.pluginRollbackBoundary ||
      !(this.pluginParentContext || pluginInvocationDepth(this) > 0)
    )
      return;
    const failure = new DataError(
      'ISV code reduced the open transaction count. Custom plug-ins should not catch exceptions from OrganizationService calls and continue processing.',
      400,
      'PluginTransactionAborted',
      { innerCode: '0x8009000c', cause: cause?.message ?? String(cause) },
    );
    for (let boundary = this.pluginRollbackBoundary; boundary; boundary = boundary.parent)
      boundary.transactionFailure ??= failure;
  }
  assertPluginTransactionActive() {
    for (let boundary = this.pluginRollbackBoundary; boundary; boundary = boundary.parent)
      if (boundary.transactionFailure) throw boundary.transactionFailure;
  }
  checkpointElastic(mapping, row, removed = false) {
    if (!isElastic(mapping)) return;
    const key = `${mapping.logicalName}\u0000${recordKey(mapping, row)}`;
    const lastEvent = this.committedEventCandidates?.at(-1);
    for (let boundary = this.pluginRollbackBoundary; boundary; boundary = boundary.parent) {
      (boundary.elasticWrites ??= new Map()).set(key, { mapping, row: clone(row), removed });
      boundary.elasticVersion = this.state.rowVersion ?? 0;
      if (lastEvent?.entity === mapping.logicalName) (boundary.elasticEvents ??= []).push(lastEvent);
    }
    this.elasticCommitSequence = (this.elasticCommitSequence ?? 0) + 1;
  }
  setCommittedEvents(provider) {
    this.committedEvents = typeof provider === 'function' ? provider : null;
  }
  addCommittedEvents(provider) {
    if (typeof provider !== 'function') throw new DataError('Committed event consumer must be a function.');
    this.committedEventConsumers ??= new Set();
    this.committedEventConsumers.add(provider);
    return () => this.committedEventConsumers.delete(provider);
  }
  /** A commit stager runs synchronously inside the committing transaction, right before its save, with that commit's
   * events (read-only) and the sequence their dispatch will carry: rows it writes commit or roll back with the events'
   * rows. A function it returns runs after the commit (never after a failed one). A throwing stager fails the commit. */
  addCommitStager(fn) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction')
      throw new DataError('Commit stagers must be synchronous functions.', 400, 'InvalidCommitStager');
    this.commitStagers ??= new Set();
    this.commitStagers.add(fn);
    return () => this.commitStagers.delete(fn);
  }
  stageOnCommit(events) {
    if (!events?.length || !this.commitStagers?.size) return [];
    const sequence = (this.committedEventSequence ?? 0) + 1,
      after = [];
    for (const stage of [...this.commitStagers]) {
      const done = stage(events, { sequence });
      if (typeof done === 'function') after.push(done);
    }
    return after;
  }
  afterStagedCommit(after) {
    for (const done of after)
      try {
        done();
      } catch (error) {
        this.committedEventErrors ??= [];
        this.committedEventErrors.push({ code: error.code ?? 'CommitStagerError', message: error.message });
        if (this.committedEventErrors.length > 50) this.committedEventErrors.shift();
      }
  }
  /** Synchronous storage observers stage derived local state inside the current transaction. */
  addMutationObserver(fn, { matches } = {}) {
    if (
      typeof fn !== 'function' ||
      fn.constructor?.name === 'AsyncFunction' ||
      (matches !== undefined && (typeof matches !== 'function' || matches.constructor?.name === 'AsyncFunction'))
    )
      throw new DataError(
        'Mutation observers and their matchers must be synchronous functions.',
        400,
        'InvalidMutationObserver',
      );
    const observer = { fn, matches };
    this.mutationObservers ??= new Set();
    this.mutationObservers.add(observer);
    return () => this.mutationObservers.delete(observer);
  }
  /** Synchronous delete admission runs before plug-ins and cascading writes, including SDK deletes. */
  addDeleteGuard(fn) {
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction')
      throw new DataError('Delete guards must be synchronous functions.', 400, 'InvalidDeleteGuard');
    this.deleteGuards ??= new Set();
    this.deleteGuards.add(fn);
    return () => this.deleteGuards.delete(fn);
  }
  recordCommittedEvent(entity, operation, row, attributes, details = {}) {
    if (
      !this.mutationObservers?.size &&
      (!(this.committedEvents || this.committedEventConsumers?.size || this.commitStagers?.size) ||
        !this.committedEventCandidates)
    )
      return;
    // correlationId is the request's (request-context.mjs), a separate field: the per-root-event chain ids stay as they are.
    const event = {
      entity,
      operation,
      row: clone(row),
      submittedAttributes: [...attributes],
      ...clone(details),
      frame: clone(details.frame ?? this.pluginFrames?.get(row) ?? {}),
      chain: this.flowChain ? clone(this.flowChain) : null,
      correlationId: currentRequest()?.correlationId ?? null,
    };
    for (const observer of details.messageEvent ? [] : (this.mutationObservers ?? [])) {
      const matched = observer.matches ? observer.matches(clone(event)) : true;
      if (matched && typeof matched.then === 'function') {
        Promise.resolve(matched).catch(() => {});
        throw new DataError('Mutation observer matchers cannot return a promise.', 500, 'InvalidMutationObserver');
      }
      if (!matched) continue;
      this.ensureReadSnapshot();
      const result = observer.fn(clone(event));
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new DataError('Mutation observers cannot return a promise.', 500, 'InvalidMutationObserver');
      }
    }
    if (
      (this.committedEvents || this.committedEventConsumers?.size || this.commitStagers?.size) &&
      this.committedEventCandidates
    )
      this.committedEventCandidates.push(event);
  }
  dispatchCommittedEvents(events) {
    if (!events.length) return;
    const captured = clone(events),
      providers = [this.committedEvents, ...(this.committedEventConsumers ?? [])].filter(Boolean),
      sequence = (this.committedEventSequence = (this.committedEventSequence ?? 0) + 1);
    this.committedEventDispatches ??= new Set();
    const delivery = new Promise((resolve) =>
      queueMicrotask(() => {
        for (const provider of providers)
          try {
            provider(clone(captured), { sequence });
          } catch (error) {
            this.committedEventErrors ??= [];
            this.committedEventErrors.push({
              code: error.code ?? 'CommittedEventConsumerError',
              message: error.message,
              sequence,
            });
            if (this.committedEventErrors.length > 50) this.committedEventErrors.shift();
          }
        resolve();
      }),
    ).finally(() => this.committedEventDispatches.delete(delivery));
    this.committedEventDispatches.add(delivery);
  }
  async flushCommittedEvents() {
    while (this.committedEventDispatches?.size) await Promise.all([...this.committedEventDispatches]);
  }
  /** Runtime composition may omit an unused result; inputs and default snapshots remain detached. */
  async replaceState(
    state,
    {
      expectedSnapshot,
      expectedDigest,
      expectedRevision,
      returnSnapshot = true,
      cloneInput = true,
      skipSaveIfUnchanged = false,
    } = {},
  ) {
    return this.transact(
      () => {
        if (expectedRevision !== undefined && this.revision !== expectedRevision)
          throw new DataError(
            'Local state changed before replacement; no imported state was applied',
            409,
            'StateConflict',
          );
        if (expectedDigest !== undefined && this.snapshotDigest() !== expectedDigest)
          throw new DataError(
            'Local state changed before replacement; no imported state was applied',
            409,
            'StateConflict',
          );
        if (expectedSnapshot !== undefined && JSON.stringify(this.snapshot()) !== expectedSnapshot)
          throw new DataError(
            'Local state changed before replacement; no imported state was applied',
            409,
            'StateConflict',
          );
        const next = normalizeState(state, this.presetLibrary, this.platformConfig, !cloneInput);
        // Replacement never edits the old graph. Retain it as the rollback input
        // instead of copying it on the successful path; failed saves still restore
        // a detached copy through the ordinary transaction rollback.
        const boundary = this.pluginRollbackBoundary;
        const frame = transactionFrameOf(this);
        if (frame?.store === this && frame.initializing) {
          // No readers have been published. A failed initialization discards
          // the store, so its superseded graph need not survive the streamed
          // commit as a rollback input. The durable file remains authoritative.
          this._state = next;
        } else {
          boundary.backup ??= this.state;
          boundary.persistenceBackup ??= this.state;
        }
        this.state = next;
        return returnSnapshot ? this.state : undefined;
      },
      { cloneResult: returnSnapshot, lazyReadSnapshot: true, skipSaveIfUnchanged },
    );
  }
  /**
   * Read-only tables a host derives from the portal export (site components,
   * web role memberships): provider() -> { tables: { logical: { mapping, rows } },
   * relationships: { logical: { navigation: rel } } }. Local mappings and rows win.
   */
  setSiteTables(provider) {
    this.virtualTables = typeof provider === 'function' ? provider : null;
  }
  /**
   * The site's observed platform behaviour (createSimulator `observed`,
   * lib/project-config.mjs observedConfig). rules() reads anonymousDataAccess.
   */
  setObserved(observed) {
    this.observed = observed ?? null;
  }
  /** The site's authorization bridge (portal-authorization.mjs): rules(), get() and queryContext() call it. */
  setPortalAuthorization(bridge) {
    this.portalAuthorization = bridge ?? null;
  }
  /** Exported registrations use the explicitly selected trusted execution mode. */
  setPluginPipeline(provider, active = () => true, requiresCheckpoint = () => true) {
    if (typeof provider !== 'function') throw new DataError('Plugin pipeline must be a function.');
    this.pluginPipeline = provider;
    this.pluginPipelineActive = (context = {}) =>
      !provider.steps && pluginStepBypassed(provider, context, provider.diagnostic) ? false : active(context);
    this.pluginPipelineRequiresCheckpoint = requiresCheckpoint;
  }
  /**
   * The record-write drivers. createSteps/updateSteps/removeSteps/upsertSteps (and the cascade and commit steps they delegate
   * to) yield the argument list of each exportedPluginPhase call. runRecordSteps runs a phase synchronously: a synchronous
   * service endpoint step posts through the synchronous I/O bridge (createRecord, the SDK drive inside a plug-in).
   * awaitRecordSteps passes awaitIo, so such a step answers a promise that is awaited before the write continues (createRecordAsync,
   * every HTTP-driven write and the async create/update/upsert/remove). A failed phase is thrown into the generator at its yield,
   * so both drivers fail, roll back and restore pluginInTransaction exactly as one synchronous call does.
   */
  runRecordSteps(steps) {
    if (!this.hasOperationContext()) return this.withOperationContext(() => this.runRecordSteps(steps));
    let next = steps.next();
    while (!next.done) {
      let answer,
        failed = false;
      try {
        answer = this.exportedPluginPhase(...next.value);
      } catch (error) {
        answer = error;
        failed = true;
      }
      next = failed ? steps.throw(answer) : steps.next(answer);
    }
    return next.value;
  }
  async awaitRecordSteps(steps) {
    if (!this.hasOperationContext()) return this.withOperationContext(() => this.awaitRecordSteps(steps));
    let next = steps.next();
    while (!next.done) {
      let answer,
        failed = false;
      try {
        answer = this.exportedPluginPhase(...next.value, true);
        if (typeof answer?.then === 'function') answer = await answer;
      } catch (error) {
        answer = error;
        failed = true;
      }
      next = failed ? steps.throw(answer) : steps.next(answer);
    }
    return next.value;
  }
  /** Runs fn(error) when the outermost open transaction rolls back: the note for a post that already left the process and
   * cannot be withdrawn (dataverse-webhooks.mjs SERVICE_ENDPOINT_SENT_BEFORE_ROLLBACK). Outside a transaction it does nothing. */
  onRollback(fn) {
    let boundary = this.pluginRollbackBoundary;
    while (boundary?.parent) boundary = boundary.parent;
    if (boundary) (boundary.rollbackNotes ??= []).push(fn);
  }
  /** Runs fn() once the outermost open transaction has committed (dataverse-virtual-providers.mjs: an enlisted provider's
   * commit). Outside a transaction it does nothing. */
  onCommit(fn) {
    let boundary = this.pluginRollbackBoundary;
    while (boundary?.parent) boundary = boundary.parent;
    if (boundary) (boundary.commitNotes ??= []).push(fn);
  }
  exportedPluginPhase(
    mapping,
    operation,
    stage,
    target,
    row,
    previous,
    identity,
    changedAttributes,
    options = {},
    awaitIo = false,
  ) {
    if (stage !== 10) this.pluginInTransaction = !isElastic(mapping);
    if (operation === 'update') changedAttributes = Object.keys(target ?? {});
    // The merged bulk driver already ran every selected source step. Public
    // custom-logic bypass instead remains a per-step ownership decision.
    if (options.skipPluginPipeline) return;
    if (
      !this.pluginPipeline ||
      !this.pluginPipelineActive({
        entity: mapping.logicalName,
        operation,
        bypassCustomPlugins: options.bypassCustomPlugins,
        bypassStepIds: options.bypassStepIds,
      })
    )
      return;
    if (
      this.rowTransaction &&
      this.pluginPipelineRequiresCheckpoint({
        entity: mapping.logicalName,
        operation,
        stage,
        changedAttributes,
        bypassCustomPlugins: options.bypassCustomPlugins,
        bypassStepIds: options.bypassStepIds,
      })
    ) {
      // Trusted external handlers may mutate arbitrary state, including nested
      // SDK transactions. Promote only when one actually executes, preserving
      // their independent PreValidation commit/rollback semantics.
      this.promoteRowTransaction();
    }
    const id = row[mapping.idColumn],
      targetPrimary = target?.[mapping.idColumn];
    if (operation === 'update' && options.preValidationSourceOperation === 'upsert' && !options.frameworkInputTarget)
      options.frameworkInputTarget = clone(target);
    const frame = this.pluginPipeline?.({
      entity: mapping.logicalName,
      operation,
      stage,
      target,
      record: row,
      previous,
      identity,
      changedAttributes,
      portalRequest: options.portalRequest === true,
      sdkFromSandbox: options.sdkFromSandbox === true,
      acceptLanguage: options.pluginAcceptLanguage ?? '',
      ...(options.frameworkInputTarget ? { frameworkInputTarget: options.frameworkInputTarget } : {}),
      ...(stage !== 10 && this.pluginMainTargets?.has(row) ? { mainTarget: this.pluginMainTargets.get(row) } : {}),
      ...(options.preValidationSourceOperation
        ? { preValidationSourceOperation: options.preValidationSourceOperation }
        : {}),
      ...(options.omitConcurrencyBehavior
        ? { concurrencyBehavior: null }
        : options.pluginConcurrencyBehavior === undefined
          ? {}
          : { concurrencyBehavior: options.pluginConcurrencyBehavior }),
      bypassStepIds: options.bypassStepIds,
      bypassCustomPlugins: options.bypassCustomPlugins,
      ...(awaitIo ? { awaitIo: true } : {}),
    });
    if (typeof frame?.then === 'function')
      return frame.then((answer) =>
        this.afterPluginPhase(mapping, operation, stage, target, row, options, id, answer, targetPrimary),
      );
    this.afterPluginPhase(mapping, operation, stage, target, row, options, id, frame, targetPrimary);
  }
  afterPluginPhase(mapping, operation, stage, target, row, options, id, frame, targetPrimary) {
    if (frame) {
      this.pluginFrames ??= new WeakMap();
      this.pluginFrames.set(row, frame);
    }
    if (stage === 40) handoffPluginResponse(this, operation, mapping.logicalName, frame, options.sdkResponseToken);
    if (!equal(row[mapping.idColumn], id))
      throw new DataError('Plugin target cannot replace the primary key.', 400, 'LocalPluginInvalid');
    if (stage !== 40 && operation !== 'delete') {
      const normalized = this.normalizeRecord(mapping, target);
      // A plug-in Target carries SDK values, not Web API wire input: a DateOnly column holds a DateTime and a choices
      // column an option array (OptionSetValueCollection), stored as the Web API's comma-separated values.
      if (options.dataverseWebApi)
        for (const [key, value] of Object.entries(normalized))
          if (
            Array.isArray(value) &&
            fieldKind(this.fieldDefinition(mapping.logicalName, key, options.metadata)) === 'multichoice'
          )
            normalized[key] = value.join(',');
      if (options.coerce)
        this.coerceRecord(mapping, normalized, {
          ...options,
          dataverseWebApi: false,
          dataverseHttpReader: undefined,
          odataErrorDetails: false,
        });
      const retainsEmpty =
        operation === 'create' &&
        stage === 10 &&
        targetPrimary === '00000000-0000-0000-0000-000000000000' &&
        normalized[mapping.idColumn] === targetPrimary;
      if (normalized[mapping.idColumn] !== undefined && !equal(normalized[mapping.idColumn], id) && !retainsEmpty)
        throw new DataError('Plugin target cannot replace the primary key.', 400, 'LocalPluginInvalid');
      // An empty text value stays an empty string in the Target while the row stores null.
      const blanks = Object.keys(normalized).filter((name) => target[name] === '' && normalized[name] === null);
      Object.assign(target, normalized);
      for (const name of blanks) target[name] = '';
      // The main operation's own Target (a later step's Create/Update stage-30 parent) is the Target as
      // PreValidation left it, before platform stamps and PreOperation edits.
      if (stage === 10) (this.pluginMainTargets ??= new WeakMap()).set(row, clone(target));
      if (retainsEmpty) delete normalized[mapping.idColumn];
      Object.assign(row, normalized);
      if (options.coerce) this.assertStateStatus(mapping, row, options);
    }
  }
  virtualTable(name) {
    const tables = this.virtualTables?.()?.tables;
    if (!tables) return null;
    if (own(tables, name)) return tables[name];
    return Object.values(tables).find((table) => table.mapping.entitySet === name) ?? null;
  }
  /** Rows of a table: a virtual site table when the host supplies one, else local data. */
  tableRows(logical) {
    const rows = this.virtualTable(logical)?.rows ?? this.state.tables[logical] ?? [];
    // Elastic tables only: rows past their time to live are hidden from every reader (dataverse-elastic.mjs installs expiryFilter).
    return this.expiryFilter && this.state.mappings?.[logical]?.tableType === 'Elastic'
      ? this.expiryFilter(logical, rows)
      : rows;
  }
  /** Site tables are derived from the export; local writes to them aren't simulated. */
  assertWritable(logical) {
    if (this.virtualTable(logical))
      throw new DataError(
        `${logical} rows come from the portal export and are read-only locally.`,
        501,
        'NotImplemented',
      );
  }
  resolveMapping(entity) {
    safeName(entity);
    let logical = entity;
    let m = this.state.mappings[entity];
    if (!m) {
      const hit = Object.entries(this.state.mappings).find(([, value]) => value.entitySet === entity);
      if (hit) {
        logical = hit[0];
        m = hit[1];
      }
    }
    if (!m && !own(this.state.tables, logical)) {
      const site = this.virtualTable(entity);
      if (!site) throw new DataError(`No mapping or local table for ${entity}`, 404, 'UnknownEntity');
      logical = site.mapping.logicalName;
      m = site.mapping;
    }
    const resolved = {
      logicalName: logical,
      entitySet: m?.entitySet ?? logical,
      idColumn: m?.idColumn ?? `${logical}id`,
      relationships: m?.relationships ?? {},
      ...m,
    };
    const extra = this.virtualTables?.()?.relationships?.[logical];
    if (extra) resolved.relationships = { ...extra, ...(m?.relationships ?? {}) };
    return resolved;
  }
  rules(entity, operation, identity = {}) {
    // "Disable anonymous access", a tenant governance
    // control that the export can't show: observed.anonymousDataAccess "blocked" keeps
    // anonymous visitors from reading Dataverse data even when a table permission grants
    // the Anonymous Users role; they can still write data.
    if (
      operation === 'read' &&
      this.observed?.anonymousDataAccess === 'blocked' &&
      !identity.admin &&
      !identity.id &&
      !identity.contactId
    )
      return [];
    const roleIds = new Set((identity.roleIds ?? []).map((id) => String(id).toLowerCase()));
    const roles = new Set([
      ...(identity.roles ?? []),
      ...(identity.roleSource === 'memberships'
        ? []
        : identity.id || identity.contactId
          ? ['Authenticated Users']
          : ['Anonymous Users']),
    ]);
    const anonymous = !identity.admin && !identity.id && !identity.contactId;
    const granted = this.state.permissions.filter(
      (p) =>
        p.enabled !== false &&
        (p.entity === entity || p.entity === '*') &&
        (p.operations ?? ['read']).includes(operation) &&
        (identity.roleSource === 'memberships' && (p.imported || p.roleIds?.length)
          ? (p.roleIds ?? []).some((id) => roleIds.has(String(id).toLowerCase()))
          : !p.roles?.length || p.roles.some((r) => roles.has(r))) &&
        (!anonymous || this.grantsWithoutContact(p)),
    );
    // Enhanced authorization: a grant also needs the Dataverse privilege of its mapped security role (portal-authorization.mjs).
    return this.portalAuthorization
      ? this.portalAuthorization.filterRules(granted, entity, operation, identity)
      : granted;
  }
  /**
   * Whether a table permission can grant anything to a visitor without a contact. The
   * Self, Contact and Account scopes, and parent chains rooted in them, need the
   * signed-in contact, so for anonymous visitors they grant nothing and a table they
   * alone cover answers 403 90040120. Natively, a Self grant on the Anonymous
   * Users role still answers 403 to an anonymous contacts read.
   */
  grantsWithoutContact(rule, seen = new Set()) {
    const scope = rule.scope ?? 'global';
    if (scope === 'global') return true;
    if (rule.observedOrphanParent?.field) return true;
    if (scope !== 'parent' || seen.has(rule.id)) return false;
    seen.add(rule.id);
    const parentId = rule.parentPermissionId ?? rule.parentId;
    const parent =
      parentId == null ? null : this.state.permissions.find((p) => p.enabled !== false && equal(p.id, parentId));
    return Boolean(parent) && this.grantsWithoutContact(parent, seen);
  }
  /**
   * Per-evaluation indexes and results for table-permission checks. Parent
   * and identity scopes look rows up by key instead of scanning every parent
   * and intersect row for every child (rows x parents x edges). A memo is
   * only valid while the store state is unchanged, so it never outlives one
   * rows() call or one top-level allowed() call.
   */
  permissionMemo() {
    const indexes = new Map(),
      results = new WeakMap(),
      rules = new Map();
    const lookup = (logical, column, value) => {
      const key = `${logical}\u0000${column}`;
      if (!indexes.has(key)) {
        const index = new Map();
        for (const item of this.tableRows(logical)) {
          const raw = field(item, column);
          if (raw == null) continue;
          const itemKey = comparable(raw);
          if (!index.has(itemKey)) index.set(itemKey, []);
          index.get(itemKey).push(item);
        }
        indexes.set(key, index);
      }
      return value == null ? [] : (indexes.get(key).get(comparable(value)) ?? []);
    };
    return {
      lookup,
      results,
      rules: (entity, operation, identity) => {
        const key = `${entity}\u0000${operation}`;
        if (!rules.has(key)) rules.set(key, this.rules(entity, operation, identity));
        return rules.get(key);
      },
      /** Targets related to `row` through `rel` (direct lookup or intersect table). */
      related: (row, rel, targetLogical) => {
        const value = field(row, rel.from);
        if (value == null) return [];
        if (!rel.intersect) return lookup(targetLogical, rel.to, value);
        const edgeTable = this.resolveMapping(rel.intersect.entity).logicalName;
        const out = [];
        for (const edge of lookup(edgeTable, rel.intersect.from, value)) {
          const target = field(edge, rel.intersect.to);
          if (target != null) out.push(...lookup(targetLogical, rel.to, target));
        }
        return out;
      },
    };
  }
  allowed(entity, operation, row, identity = {}, chain = new Set(), permissionId = null, memo = this.permissionMemo()) {
    if (identity.admin || this.state.settings.permissionMode === 'permissive') return true;
    const mapping = this.resolveMapping(entity);
    const visit = `${mapping.logicalName}:${scalar(row?.[mapping.idColumn])}:${operation}:${permissionId ?? '*'}`;
    if (chain.has(visit)) throw new DataError('Cyclic parent table permission', 400, 'InvalidPermission');
    const rowId = row?.[mapping.idColumn];
    const cacheKey = rowId == null ? null : `${mapping.logicalName}\u0000${operation}\u0000${permissionId ?? '*'}`;
    const cached = row && typeof row === 'object' ? memo.results.get(row) : null;
    if (cacheKey != null && cached?.has(cacheKey)) return cached.get(cacheKey);
    const nextChain = new Set([...chain, visit]);
    const result = memo
      .rules(mapping.logicalName, operation, identity)
      .filter((rule) => !permissionId || equal(rule.id, permissionId))
      .some((rule) => {
        const scope = rule.scope ?? 'global';
        if (scope === 'global') return true;
        if (!row) return false;
        if (rule.observedOrphanParent?.field) return field(row, rule.observedOrphanParent.field) != null;
        if (rule.identityRelationship) {
          const rel = rule.identityRelationship;
          const im = this.resolveMapping(rel.entity);
          const identityId = rel.entity === 'account' ? identity.accountId : (identity.contactId ?? identity.id);
          if (!identityId) return false;
          const person = memo.lookup(im.logicalName, im.idColumn, identityId);
          if (!person.length) return false;
          const people = new Set(person);
          return memo.related(row, rel, im.logicalName).some((target) => people.has(target));
        }
        const value = scalar(
          field(
            row,
            rule.field ??
              (scope === 'self' ? mapping.idColumn : scope === 'account' ? 'parentcustomerid' : 'contactid'),
          ),
        );
        if (scope === 'self' || scope === 'contact')
          return Boolean(identity.contactId || identity.id) && equal(value, identity.contactId ?? identity.id);
        if (scope === 'account') return Boolean(identity.accountId) && equal(value, identity.accountId);
        if (scope === 'parent') {
          const rel = rule.relationship;
          if (!rel?.entity || !rel.from || !rel.to)
            throw new DataError('Parent permission requires relationship entity/from/to');
          const pm = this.resolveMapping(rel.entity);
          return memo
            .related(row, rel, pm.logicalName)
            .some((parent) =>
              this.allowed(
                pm.logicalName,
                'read',
                parent,
                identity,
                nextChain,
                rule.parentPermissionId ?? rule.parentId,
                memo,
              ),
            );
        }
        throw new DataError(`Unsupported permission scope ${scope}`);
      });
    if (cacheKey != null && row && typeof row === 'object') {
      let answers = memo.results.get(row);
      if (!answers) memo.results.set(row, (answers = new Map()));
      answers.set(cacheKey, result);
    }
    return result;
  }
  assertAllowed(entity, operation, row, identity, related) {
    if (!this.allowed(entity, operation, row, identity)) {
      const permissions = this.rules(entity, operation, identity).map((grant) => {
        const permission = { id: grant.id, name: grant.name ?? grant.id, scope: grant.scope ?? 'global' };
        for (const key of ['field', 'relationship', 'relationshipName', 'parentPermissionId'])
          if (grant[key]) permission[key] = grant[key];
        if (permission.scope === 'parent' && grant.relationship)
          permission.parentLink = {
            childColumn: grant.relationship.from ?? null,
            value: scalar(row?.[grant.relationship.from]) ?? null,
            parentTable: grant.relationship.entity ?? null,
            parentColumn: grant.relationship.to ?? null,
            ...(grant.relationship.intersect ? { intersect: grant.relationship.intersect } : {}),
          };
        return permission;
      });
      const descriptions = permissions.map((grant) => {
        const relationship =
          grant.relationshipName ??
          (typeof grant.relationship === 'string'
            ? grant.relationship
            : grant.relationship
              ? `${entity}.${grant.relationship.from} → ${grant.relationship.entity}.${grant.relationship.to}`
              : null);
        return `${grant.name} (${grant.scope})${relationship ? ' relationship ' + relationship : ''}`;
      });
      const message =
        `Table permission denies ${operation} on ${entity}` +
        (descriptions.length ? ': ' + descriptions.join('; ') : '');
      throw new DataError(message, 403, 'PermissionDenied', {
        operation,
        table: entity,
        permissions,
        permissionDiagnostic: {
          code: 'TABLE_PERMISSION_DENIED',
          severity: 'warning',
          operation,
          table: entity,
          permissions,
          message,
          model: this.portalAuthorization?.describe().model ?? 'standard',
        },
        ...(related ? { related } : {}),
      });
    }
  }
  rows(entity, identity = {}, subset) {
    const m = this.resolveMapping(entity);
    const memo = this.permissionMemo();
    const rows = subset ?? this.tableRows(m.logicalName);
    if (this.allowed === DataStore.prototype.allowed) {
      if (identity.admin || this.state.settings.permissionMode === 'permissive') return rows.filter(() => true);
      const length = rows.length;
      let present = false;
      for (let index = 0; index < length; index++)
        if (index in rows) {
          present = true;
          break;
        }
      if (!present) return [];
      const rules = memo.rules(m.logicalName, 'read', identity);
      if (!rules.length) return [];
      if ((rules[0].scope ?? 'global') === 'global') return rows.filter(() => true);
    }
    return rows.filter((r) => this.allowed(m.logicalName, 'read', r, identity, new Set(), null, memo));
  }
  /** Exact permission-filtered count without materializing the visible rows. */
  rowCount(entity, identity = {}, subset) {
    const m = this.resolveMapping(entity);
    const rows = subset ?? this.tableRows(m.logicalName);
    const unrestricted = identity.admin || this.state.settings.permissionMode === 'permissive';
    const memo = unrestricted ? null : this.permissionMemo();
    const length = rows.length;
    const storedCount = pagedRecordsOf(rows)?.present;
    if (storedCount === 0 || (unrestricted && storedCount !== undefined)) return storedCount;
    // A missing grant and an unconditional first grant cannot depend on row
    // contents. Keep custom per-row authorization hooks on the ordinary path.
    if (!unrestricted && this.allowed === DataStore.prototype.allowed) {
      let present = false;
      for (let index = 0; index < length; index++)
        if (index in rows) {
          present = true;
          break;
        }
      if (!present) return 0;
      const rules = memo.rules(m.logicalName, 'read', identity);
      if (!rules.length) return 0;
      if ((rules[0].scope ?? 'global') === 'global') {
        if (storedCount !== undefined) return storedCount;
        let count = 0;
        for (let index = 0; index < length; index++) if (index in rows) count++;
        return count;
      }
    }
    let count = 0;
    for (let index = 0; index < length; index++)
      if (
        index in rows &&
        (unrestricted || this.allowed(m.logicalName, 'read', rows[index], identity, new Set(), null, memo))
      )
        count++;
    return count;
  }
  relationshipMatches(row, target, rel) {
    if (!rel.intersect) return field(row, rel.from) != null && equal(field(row, rel.from), field(target, rel.to));
    const mapping = this.resolveMapping(rel.intersect.entity);
    return this.tableRows(mapping.logicalName).some(
      (edge) =>
        field(row, rel.from) != null &&
        field(target, rel.to) != null &&
        equal(field(row, rel.from), field(edge, rel.intersect.from)) &&
        equal(field(target, rel.to), field(edge, rel.intersect.to)),
    );
  }
  /**
   * A copy of a stored row as a portal read receives it: computed columns (setComputedColumns) hold their computed value,
   * and each single-valued lookup is an entity reference { id, logical_name, name } named by the target's primary name
   * (a stored bare id resolves through the N:1 relationship; a polymorphic one through the target that holds the id).
   */
  portalReadRow(m, row) {
    return this.namedReferences(
      m,
      this.computedColumns(m.logicalName) ? this.withComputed(m.logicalName, [row])[0] : row,
    );
  }
  /** A copy of the row whose single-valued lookups are named entity references, as portalReadRow names them. */
  namedReferences(m, row) {
    const out = { ...row };
    const byColumn = new Map();
    for (const rel of Object.values(m.relationships ?? {}))
      if (rel?.many === false && rel.from && rel.from !== m.idColumn && rel.entity)
        byColumn.set(rel.from, [...(byColumn.get(rel.from) ?? []), rel.entity]);
    for (const [column, entities] of byColumn) {
      const value = out[column];
      if (value == null || value === '' || (typeof value === 'object' && (Array.isArray(value) || value.name != null)))
        continue;
      const id = typeof value === 'object' ? value.id : value;
      if (id == null) continue;
      const wanted = typeof value === 'object' && value.logical_name ? [value.logical_name] : entities;
      for (const logical of wanted) {
        let target;
        try {
          target = this.resolveMapping(logical);
        } catch {
          continue;
        }
        const rows = this.tableRows(target.logicalName),
          hit = rows[this.rowIndex(target, rows, id)];
        if (!hit && wanted.length > 1) continue;
        out[column] = {
          ...(typeof value === 'object' ? value : {}),
          id,
          logical_name: target.logicalName,
          name: hit ? (primaryNameValue(target, hit) ?? '') : '',
        };
        break;
      }
    }
    return out;
  }
  get(entity, id, identity = {}, options = {}) {
    if (!this.hasOperationContext()) return this.withOperationContext(() => this.get(entity, id, identity, options));
    const m = this.resolveMapping(entity);
    const read = (key, columns = options.sdkColumns) => {
      const rows = options.readRow ? null : this.tableRows(m.logicalName);
      let row = options.readRow ? options.readRow(key) : rows[this.rowIndex(m, rows, key, options)];
      if (!row) return null;
      this.assertAllowed(m.logicalName, 'read', row, identity);
      options.authorizeRead?.(row);
      // A portal read (forms, Liquid entity reads) sees what a Dataverse read answers: computed columns hold their value and
      // lookups are entity references carrying the target's primary name.
      if (options.portalRequest) row = this.portalReadRow(m, row);
      // Column security of the reading principal (portal-authorization.mjs maskRow): the mapped user (enhanced model) or, for a
      // portal request, the site's application user; secured columns are null or answer their masking rule.
      if (this.portalAuthorization)
        row = this.portalAuthorization.maskRow(identity, m.logicalName, row, {
          portalRequest: options.portalRequest === true,
        });
      return options.project ? options.project(clone(row), key, columns) : clone(row);
    };
    if (
      !options.skipPluginRead &&
      this.pluginPipeline &&
      this.pluginPipelineActive({
        entity: m.logicalName,
        operation: 'retrieve',
        bypassCustomPlugins: options.bypassCustomPlugins === true,
        bypassStepIds: options.bypassStepIds,
      })
    ) {
      this.ensureReadSnapshot();
      const originalId =
        typeof id === 'string' && GUID_PATTERN.test(id)
          ? id
          : (() => {
              const rows = this.tableRows(m.logicalName);
              return rows[this.rowIndex(m, rows, id, options)]?.[m.idColumn] ?? '00000000-0000-0000-0000-000000000000';
            })();
      const record = { [m.idColumn]: originalId },
        columns = clone(options.sdkColumns ?? { allColumns: true, columns: [] }),
        holder = {
          target: clone(options.sdkTarget ?? { $type: 'EntityReference', logicalName: m.logicalName, id: originalId }),
        },
        previousReadOnly = this.pluginReadOnly;
      this.pluginReadOnly = !this.pluginRollbackBoundary;
      try {
        this.pluginPipeline({
          entity: m.logicalName,
          operation: 'retrieve',
          stage: 10,
          record,
          identity,
          columns,
          holder,
          changedAttributes: [],
          ...(options.readInitialFrame ? { initialFrame: options.readInitialFrame } : {}),
          bypassCustomPlugins: options.bypassCustomPlugins === true,
          bypassStepIds: options.bypassStepIds,
          portalRequest: options.portalRequest === true,
        });
        this.pluginPipeline({
          entity: m.logicalName,
          operation: 'retrieve',
          stage: 20,
          record,
          identity,
          columns,
          holder,
          changedAttributes: [],
          bypassCustomPlugins: options.bypassCustomPlugins === true,
          bypassStepIds: options.bypassStepIds,
          portalRequest: options.portalRequest === true,
        });
        if (
          holder.target?.$type !== 'EntityReference' ||
          holder.target.logicalName !== m.logicalName ||
          typeof holder.target.id !== 'string'
        )
          throw new DataError(
            'Retrieve Target must retain its bound logical table and an ID.',
            501,
            'LocalPluginQueryUnsupported',
          );
        if (typeof columns.allColumns !== 'boolean' || !Array.isArray(columns.columns ?? []))
          throw new DataError('Retrieve requires a valid ColumnSet.', 400, 'LocalPluginQueryUnsupported');
        const row = read(options.resolveTarget ? options.resolveTarget(holder.target) : holder.target.id, columns);
        if (!row) return null;
        Object.assign(record, row, { [m.idColumn]: originalId });
        holder.entity = recordToSdkReadEntity(this, m.logicalName, row, columns);
        const responseFrame = this.pluginPipeline({
          entity: m.logicalName,
          operation: 'retrieve',
          stage: 40,
          record,
          identity,
          columns,
          holder,
          changedAttributes: [],
          bypassCustomPlugins: options.bypassCustomPlugins === true,
          bypassStepIds: options.bypassStepIds,
          portalRequest: options.portalRequest === true,
        });
        handoffPluginResponse(this, 'retrieve', m.logicalName, responseFrame, options.sdkResponseToken);
        if (
          holder.entity?.$type !== 'Entity' ||
          holder.entity.logicalName !== m.logicalName ||
          !equal(holder.entity.id, row[m.idColumn])
        )
          throw new DataError('Retrieve output must preserve record identity.', 501, 'LocalPluginQueryUnsupported');
        return {
          ...Object.fromEntries(Object.entries(row).filter(([, value]) => value === null)),
          ...Object.fromEntries(
            (options.preserveProperties ?? [])
              .filter((key) => Object.hasOwn(row, key))
              .map((key) => [key, clone(row[key])]),
          ),
          ...sdkValueToRecord(holder.entity),
          [m.idColumn]: row[m.idColumn],
          ...(isElastic(m) ? { partitionid: row.partitionid ?? null } : {}),
        };
      } finally {
        this.pluginReadOnly = previousReadOnly;
      }
    }
    // options.project (records readInternal): the shared read projection over a copy of the stored row.
    const row = read(id);
    if (!row) return null;
    if (options.sdkColumns)
      return {
        ...sdkValueToRecord(recordToSdkEntity(this, m.logicalName, row, options.sdkColumns)),
        [m.idColumn]: row[m.idColumn],
        ...(isElastic(m) ? { partitionid: row.partitionid ?? null } : {}),
      };
    return row;
  }
  /** Field metadata from explicit mappings or a caller-supplied solution metadata resolver. */
  fieldDefinition(logical, attribute, metadata) {
    if (!attribute) return undefined;
    const lookup = /^_(.+)_value$/.exec(attribute);
    const name = lookup ? lookup[1] : attribute;
    const find = (fields) =>
      fields && typeof fields === 'object'
        ? (fields[name] ?? fields[Object.keys(fields).find((key) => key.toLowerCase() === name.toLowerCase())])
        : undefined;
    let mapping;
    try {
      mapping = this.resolveMapping(logical);
    } catch {
      mapping = null;
    }
    const external = typeof metadata === 'function' ? metadata(mapping?.logicalName ?? logical) : null;
    return find(external) ?? find(mapping?.fields) ?? find(mapping?.fieldMetadata);
  }
  /** Fiscal calendar settings: explicit settings win over the organization row. */
  fiscalSettings(settings = this.state.settings ?? {}) {
    const explicit = ['fiscalCalendarStart', 'fiscalPeriodType', 'fiscalPeriodsPerYear'].some(
      (key) => settings[key] != null && settings[key] !== '',
    );
    if (explicit)
      return {
        fiscalCalendarStart: settings.fiscalCalendarStart,
        fiscalPeriodType: settings.fiscalPeriodType,
        fiscalPeriodsPerYear: settings.fiscalPeriodsPerYear,
      };
    const organizations = this.state.tables?.organization ?? [];
    if (organizations.length !== 1) return {};
    const [organization] = organizations;
    return {
      fiscalCalendarStart: scalar(organization.fiscalcalendarstart) ?? undefined,
      fiscalPeriodType: scalar(organization.fiscalperiodtype) ?? undefined,
    };
  }
  /** Query evaluation settings: collation, local time zone and fiscal calendar. */
  querySettings() {
    const settings = this.state.settings ?? {};
    const platform = platformValues(this.state);
    return {
      collation: settings.collation ?? 'CI_AI',
      timeZoneOffsetMinutes: Number(settings.timeZoneOffsetMinutes ?? 0),
      languageCode: settings.languageCode,
      // The organisation fiscal calendar (lib/fiscal-calendar.mjs): simulator settings, else
      // the FiscalCalendarStart and FiscalPeriodType of a single local organization row.
      ...this.fiscalSettings(settings),
      // Local bound on intermediate FetchXML join rows (FETCH_LIMITS.joinRows by default).
      fetchJoinRowLimit: this.state.simulator?.platformOverrides?.FetchJoinRowLimit ?? settings.fetchJoinRowLimit,
      fetchLimits: {
        links: platform.QueryLinkEntityLimit,
        linksAndFilters: platform.FetchLinkAndFilterLimit,
        conditionsAndLinks: platform.FetchConditionLimit,
        aggregateRecords: platform.AggregateQueryRecordLimit,
        linkDepth: platform.FetchLinkDepth,
      },
      // "strict" rejects FetchXML columns that complete Solution metadata lacks.
      fetchColumnValidation: settings.fetchColumnValidation,
      fetchAllWithoutFilter: this.observed?.fetchAllWithoutFilter,
    };
  }
  /**
   * Query-local, immutable caches of this identity's readable rows and
   * relationship indexes. Never share them across requests or mutations.
   */
  /**
   * A mapping's relationships as this caller reads them. A Dataverse caller (identity.dataverse) also gets the standard
   * navigations the mapping lacks (relationshipsOf); a portal caller gets the mapping's own, unchanged.
   */
  relationshipsFor(mapping, identity) {
    return relationshipsOf(this, mapping.logicalName, mapping.relationships ?? {}, Boolean(identity?.dataverse));
  }
  /**
   * Registers (or, with null, removes) a computed-column provider under a name: { columnsOf(logical) -> [column],
   * compute(logical, column, { row, stored }) -> value, sortable?(logical, column) -> boolean }. row is the read copy
   * (other computed columns read computed), stored the stored row. Calculated and formula columns register here.
   */
  setComputedColumns(name, provider) {
    this.computedProviders ??= new Map();
    if (provider) this.computedProviders.set(name, provider);
    else this.computedProviders.delete(name);
    this.computedMemo = null;
  }
  /** Map column -> provider of a table's computed columns, memoised per tablesRevision (metadata and mappings). */
  computedColumns(logical) {
    if (!this.computedProviders?.size) return null;
    const key = this.tablesRevision([]);
    if (this.computedMemo?.key !== key) this.computedMemo = { key, tables: new Map() };
    if (!this.computedMemo.tables.has(logical)) {
      const columns = new Map();
      for (const provider of this.computedProviders.values())
        for (const column of provider.columnsOf(logical) ?? []) if (!columns.has(column)) columns.set(column, provider);
      this.computedMemo.tables.set(logical, columns.size ? columns : null);
    }
    return this.computedMemo.tables.get(logical);
  }
  /**
   * Read copies of rows whose computed columns hold their computed value (lazy, once per copy); rows of a table
   * without computed columns are returned as they are. A computed column that reads itself (a cycle) reads null.
   */
  // ponytail: one shallow copy per row of a table with computed columns per query; an index of computed values keyed
  // by row version is the upgrade if such tables grow large.
  withComputed(logical, rows) {
    const columns = this.computedColumns(logical);
    if (!columns) return rows;
    return rows.map((stored) => {
      const row = { ...stored };
      for (const [column, provider] of columns) {
        let busy = false;
        const settle = (value) => {
          Object.defineProperty(row, column, { value, writable: true, enumerable: true, configurable: true });
          return value;
        };
        Object.defineProperty(row, column, {
          enumerable: true,
          configurable: true,
          get: () => {
            if (busy) return null;
            busy = true;
            try {
              return settle(provider.compute(logical, column, { row, stored }) ?? null);
            } finally {
              busy = false;
            }
          },
          set: settle,
        });
      }
      return row;
    });
  }
  /** One column of one row as every query reads it: the computed value for a computed column, else the stored value. */
  fieldValue(logical, row, column) {
    const name = this.resolveMapping(logical).logicalName;
    return this.computedColumns(name)?.has(column)
      ? this.withComputed(name, [row])[0][column]
      : columnValue(row, column);
  }
  /** False for a computed column whose order the platform ignores (a calculated column over a parent or another calculated column). */
  sortableColumn(logical, column) {
    const provider = this.computedColumns(logical)?.get(column);
    return provider?.sortable ? provider.sortable(logical, column) !== false : true;
  }
  queryContext(identity = {}, options = {}) {
    // Enhanced authorization: the visitor's field security profiles mask every read (portal-authorization.mjs rowMasker).
    const portalMask = !options.backendRowsMask && this.portalAuthorization?.rowMasker(identity);
    if (portalMask) options = { ...options, backendRowsMask: portalMask };
    const readable =
      options.fetchCache && !options.backendRowsFilter && !options.backendRowsMask
        ? options.fetchCache.readable(this, identity)
        : new Map();
    // Row filters are read-only (the security read filter, or a backend profile that copies the row
    // itself), so they receive the stored row. `subset` restricts one read to known rows (id reads).
    // Computed columns (setComputedColumns) read their computed value in every query engine: filter, order, $apply,
    // FetchXML conditions, orders, aggregates and the projection all see withComputed rows, never the stored value.
    // backendRowsMask(name) returns null or a function giving the row as this caller may evaluate it (column security nulls
    // the columns it cannot read), so no predicate, order, aggregate, join or lambda at any depth sees a hidden value.
    const masks = new Map();
    const maskOf = (name) => {
      if (!masks.has(name)) masks.set(name, options.backendRowsMask?.(name) ?? null);
      return masks.get(name);
    };
    const backend = (name, rows) => {
      const kept = options.backendRowsFilter
        ? rows.filter((row) => options.backendRowsFilter(name, row) === true)
        : rows;
      const computed = this.withComputed(name, kept);
      const mask = maskOf(name);
      return mask ? computed.map(mask) : computed;
    };
    const readCopies = (rows) => {
      const paged = pagedRecordsOf(rows);
      if (!paged) return rows;
      const out = [];
      for (let index = 0; index < paged.length; index++) if (paged.id(index)) out.push(paged.raw(index));
      return out;
    };
    const visibleRows = (name, subset) => {
      const source = subset ?? this.tableRows(name),
        paged = pagedRecordsOf(source);
      // Query filters, calculations and masks are read-only. Decode private
      // values directly instead of retaining a mutable facade for every row.
      // Public rows() and custom authorization hooks keep stored-row semantics.
      if (!paged || this.allowed !== DataStore.prototype.allowed) return this.rows(name, identity, source);
      const memo = this.permissionMemo();
      let unrestricted = identity.admin || this.state.settings.permissionMode === 'permissive';
      if (!unrestricted && paged.present) {
        const rules = memo.rules(name, 'read', identity);
        if (!rules.length) return [];
        unrestricted = (rules[0].scope ?? 'global') === 'global';
      }
      const rows = readCopies(source);
      return unrestricted
        ? rows
        : rows.filter((row) => this.allowed(name, 'read', row, identity, new Set(), null, memo));
    };
    const readRows = (logical, node, subset) => {
      const name = this.resolveMapping(logical).logicalName;
      if (options.permissionLinkNodes?.has(node) || options.rawQueryNodes?.has(node))
        return backend(name, readCopies(subset ?? this.tableRows(name)));
      if (subset) return backend(name, visibleRows(name, subset));
      if (!readable.has(name)) readable.set(name, backend(name, visibleRows(name)));
      return readable.get(name);
    };
    const key = (value) => {
      const raw = scalar(value);
      return raw == null || raw === '' ? null : comparable(raw);
    };
    const indexes = new Map();
    const indexBy = (cacheKey, rows, column) => {
      if (!indexes.has(cacheKey)) {
        const index = new Map();
        for (const row of rows) {
          const value = key(columnValue(row, column));
          if (value == null) continue;
          if (!index.has(value)) index.set(value, []);
          index.get(value).push(row);
        }
        indexes.set(cacheKey, index);
      }
      return indexes.get(cacheKey);
    };
    const related = (row, rel) => {
      const target = this.resolveMapping(rel.entity);
      const value = key(columnValue(row, rel.from));
      if (value == null) return [];
      if (!rel.intersect && rel.to === target.idColumn && !isElastic(target)) {
        const subset = this.primaryKeySubset(target, [value]);
        if (subset) return readRows(target.logicalName, undefined, subset);
      }
      const targets = indexBy(`t\u0000${target.logicalName}\u0000${rel.to}`, readRows(target.logicalName), rel.to);
      if (!rel.intersect) {
        const found = targets.get(value) ?? [];
        return isElastic(target) && rel.many === false
          ? found.filter((candidate) =>
              samePartition(candidate.partitionid, row[`${rel.from}pid`] ?? columnValue(row, rel.from)?.partitionid),
            )
          : found;
      }
      const edgeMapping = this.resolveMapping(rel.intersect.entity);
      const edges = indexBy(
        `e\u0000${edgeMapping.logicalName}\u0000${rel.intersect.from}`,
        this.tableRows(edgeMapping.logicalName),
        rel.intersect.from,
      );
      const out = [],
        seen = new Set();
      for (const edge of edges.get(value) ?? [])
        for (const item of targets.get(key(columnValue(edge, rel.intersect.to))) ?? [])
          if (!seen.has(item)) {
            seen.add(item);
            out.push(item);
          }
      return out;
    };
    const names = new Map(),
      requestedNames = new Map();
    const lookupName = (reference) => {
      if (!reference) return undefined;
      if (reference.name != null) return reference.name;
      const logical = reference.logical_name ?? reference.logicalName;
      if (!logical) return undefined;
      let mapping;
      try {
        mapping = this.resolveMapping(logical);
      } catch {
        return undefined;
      }
      const rows = this.tableRows(mapping.logicalName),
        stored = pagedRecordsOf(rows);
      const identifier = key(reference.id);
      if (identifier == null) return undefined;
      const positions = stored?.primaryPositions(mapping.idColumn, identifier);
      if (positions !== undefined && positions !== null) {
        // The ordinary index retains the last duplicate's label. Cache only
        // requested IDs; label formatting must not decode a complete target.
        let namesOf = requestedNames.get(mapping.logicalName);
        if (!namesOf) requestedNames.set(mapping.logicalName, (namesOf = new Map()));
        const id = identifier;
        if (!namesOf.has(id))
          namesOf.set(id, positions.length ? primaryNameValue(mapping, rows[positions.at(-1)]) : undefined);
        return namesOf.get(id);
      }
      if (!names.has(mapping.logicalName)) {
        const index = new Map();
        for (const row of this.tableRows(mapping.logicalName)) {
          const id = key(row[mapping.idColumn]);
          if (id != null) index.set(id, primaryNameValue(mapping, row));
        }
        names.set(mapping.logicalName, index);
      }
      return names.get(mapping.logicalName).get(key(reference.id));
    };
    return {
      dialect: options.dialect ?? 'extended',
      readRows,
      related,
      navigate: (mapping, row, name) => {
        const rel = this.relationshipsFor(mapping, identity)[name];
        if (!rel) return null;
        const target = this.resolveMapping(rel.entity);
        if (row == null)
          return rel.many === false
            ? { mapping: target, value: null, many: false }
            : { mapping: target, value: [], many: true };
        const rows = related(row, rel);
        return rel.many === false
          ? { mapping: target, value: rows[0] ?? null, many: false }
          : { mapping: target, value: rows, many: true };
      },
      definition: (logical, attribute) => this.fieldDefinition(logical, attribute, options.metadata),
      column: (logical, attribute) => this.columnStatus(logical, attribute, options.metadata),
      lookupName,
      identity,
      relationships: (mapping) => this.relationshipsFor(mapping, identity),
      settings: this.querySettings(),
      now: this.clock.now(),
    };
  }
  /**
   * Whether a table has a column: "known" (field metadata, a relationship column, the
   * primary key, or a stored row when the metadata isn't complete), "unknown" (the
   * mapping declares schemaComplete and none of those name it) or "unverified"
   * (incomplete metadata and no stored row has it).
   */
  columnStatus(logical, attribute, metadata) {
    let mapping;
    try {
      mapping = this.resolveMapping(logical);
    } catch {
      return 'unverified';
    }
    const name = String(attribute ?? '');
    if (!name) return 'unverified';
    const lower = name.toLowerCase();
    if (name === mapping.idColumn) return 'known';
    if (Object.keys(this.fieldDefinitions(mapping.logicalName, metadata)).some((key) => key.toLowerCase() === lower))
      return 'known';
    if (Object.values(mapping.relationships ?? {}).some((rel) => String(rel?.from ?? '').toLowerCase() === lower))
      return 'known';
    // Dataverse's virtual name columns, which Solution XML doesn't list: <lookup>name and
    // <lookup>yominame, and <choice|status|state|two-options>name (statecodename).
    const virtual = /^(.+?)(yominame|name)$/.exec(lower);
    if (virtual) {
      const definitions = this.fieldDefinitions(mapping.logicalName, metadata);
      const baseKey = Object.keys(definitions).find((key) => key.toLowerCase() === virtual[1]);
      const kind = baseKey ? fieldKind(definitions[baseKey]) : null;
      const lookup =
        kind === 'lookup' ||
        Object.values(mapping.relationships ?? {}).some(
          (rel) => rel?.many === false && String(rel.from ?? '').toLowerCase() === virtual[1],
        );
      if (lookup || (virtual[2] === 'name' && ['choice', 'multichoice', 'boolean'].includes(kind))) return 'known';
    }
    if (mapping.schemaComplete === true) return 'unknown';
    // Stored columns per table, rebuilt only after the data changes.
    const revision = this.dataRevision();
    this.storedColumns ??= new Map();
    let entry = this.storedColumns.get(mapping.logicalName);
    if (!entry || entry.revision !== revision) {
      const columns = new Set();
      for (const row of this.tableRows(mapping.logicalName)) for (const key of Object.keys(row)) columns.add(key);
      entry = { revision, columns };
      this.storedColumns.set(mapping.logicalName, entry);
    }
    return entry.columns.has(name) ? 'known' : 'unverified';
  }
  /** Resolve a $orderby/$apply path from a root row (single-valued navigation only). */
  pathValue(ctx, mapping, row, segments) {
    let current = row,
      currentMapping = mapping;
    for (const segment of segments.slice(0, -1)) {
      const navigation = ctx.navigate(currentMapping, current, segment);
      if (!navigation || navigation.many)
        throw new DataError(
          `Navigation ${segment} must be a single-valued navigation property`,
          400,
          'UnsupportedQuery',
        );
      current = navigation.value;
      currentMapping = navigation.mapping;
      if (current == null) return undefined;
    }
    return columnValue(current, segments.at(-1));
  }
  pathMapping(ctx, mapping, segments) {
    let currentMapping = mapping;
    for (const segment of segments) {
      const rel = this.relationshipsFor(currentMapping, ctx.identity)[segment];
      if (!rel)
        throw new DataError(
          `No relationship mapping for ${currentMapping.logicalName}.${segment}`,
          400,
          'MissingRelationship',
        );
      currentMapping = this.resolveMapping(rel.entity);
    }
    return currentMapping;
  }
  pathDefinition(ctx, mapping, segments) {
    const target = this.pathMapping(ctx, mapping, segments.slice(0, -1));
    return ctx.definition(target.logicalName, segments.at(-1));
  }
  /** Compile nested $expand options once per query. */
  prepareExpand(ctx, mapping, specs, query) {
    return specs.map((spec) => {
      const rel = this.relationshipsFor(mapping, ctx.identity)[spec.navigation];
      if (!rel)
        throw new DataError(
          `No relationship mapping for ${mapping.logicalName}.${spec.navigation}`,
          400,
          'MissingRelationship',
        );
      const target = this.resolveMapping(rel.entity);
      return {
        navigation: spec.navigation,
        rel,
        target,
        predicate: spec.filter ? compileODataPredicate(parseODataExpression(spec.filter, query), target, ctx) : null,
        order: parseOrderBy(spec.orderby, query),
        top: spec.top == null ? null : boundedInt(spec.top, '$top'),
        select: parseSelect(spec.select),
        expand: this.prepareExpand(ctx, target, spec.expand ?? [], query),
      };
    });
  }
  projectRow(ctx, mapping, row, select, expand, includeKeys = false) {
    // Dataverse always returns the primary key, selected or not.
    const out = project(
      row,
      includeKeys && Array.isArray(select) && !select.includes(mapping.idColumn)
        ? [...select, mapping.idColumn]
        : select,
    );
    for (const spec of expand) {
      let linked = ctx.related(row, spec.rel);
      if (spec.predicate) linked = linked.filter(spec.predicate);
      if (spec.order.length)
        linked = sortRows(linked, spec.order, {
          mapping: spec.target,
          valueOf: (item, path) => this.pathValue(ctx, spec.target, item, path),
          definition: (path) => this.pathDefinition(ctx, spec.target, path),
          lookupName: ctx.lookupName,
          collation: ctx.settings.collation,
          tieBreak: false,
        });
      if (spec.top != null) linked = linked.slice(0, spec.top);
      const nested = (item) => this.projectRow(ctx, spec.target, item, spec.select, spec.expand, includeKeys);
      out[spec.navigation] = spec.rel.many === false ? (linked[0] ? nested(linked[0]) : null) : linked.map(nested);
    }
    return out;
  }
  /**
   * OData collection query. options.dialect "dataverse" applies the public
   * Web API grammar; the default "extended" dialect serves internal reads.
   */
  query(entity, params = {}, identity = {}, paging, options = {}) {
    if (!this.hasOperationContext())
      return this.withOperationContext(() => this.query(entity, params, identity, paging, options));
    const p = params instanceof URLSearchParams ? Object.fromEntries(params) : params;
    if (p.fetchXml || p.fetchxml) return this.queryCore(entity, params, identity, paging, options);
    // Column security of the reading principal on every returned row (portal-authorization.mjs maskRow), as get() and fetchXml().
    // A filter, order or $apply over a column it reads masked is refused first (assertOperands, 0x80041155).
    if (this.portalAuthorization && !options.portalMasked) {
      const logical = this.resolveMapping(entity).logicalName;
      this.portalAuthorization.assertOperands(identity, logical, {
        portalRequest: options.portalRequest === true,
        params,
      });
      const result = this.query(entity, params, identity, paging, { ...options, portalMasked: true });
      if (Array.isArray(result?.value))
        result.value = result.value.map((row) =>
          this.portalAuthorization.maskRow(identity, logical, row, { portalRequest: options.portalRequest === true }),
        );
      return result;
    }
    const mapping = this.resolveMapping(entity);
    if (
      options.portalRequest === true &&
      !identity.admin &&
      this.observed?.odataPermissionQueryPipeline === 'native-classic'
    ) {
      if (
        (paging && (paging.offset !== 0 || paging.pageSize !== 5000 || paging.preferenceApplied)) ||
        options.id != null ||
        options.ids ||
        Object.keys(p).some((key) => !['$select', '$filter', '$orderby', '$count'].includes(key)) ||
        (p.$count !== undefined && !['true', 'false'].includes(p.$count)) ||
        Object.values(p).some((value) => String(value).includes('/'))
      )
        throw new DataError(
          'This OData navigation, paging or option conversion requires a qualified native adapter.',
          501,
          'ODataPermissionQueryUnsupported',
        );
      const scalarParams = { ...p };
      delete scalarParams.$count;
      const resolveAttribute = (table, attribute) => {
        const lookup = /^_(.+)_value$/.exec(attribute);
        return lookup && fieldKind(this.fieldDefinition(table, attribute, options.metadata)) === 'lookup'
          ? lookup[1]
          : attribute;
      };
      const permissionQuery = compileODataPermissionQuery(
        authoredScalarODataFetch(mapping.logicalName, scalarParams, { resolveAttribute }),
        {
          permissions: this.state.permissions,
          identity,
          mappings: this.state.mappings,
          rules: this.rules.bind(this),
          bypass: this.state.settings.permissionMode === 'permissive',
          grantOrder: this.observed.odataPermissionGrantOrder,
          sameTableParentAnchor: this.observed.odataSameTableParentAnchor,
          resolveAttribute,
          columnType: (table, attribute) => fieldKind(this.fieldDefinition(table, attribute, options.metadata)),
        },
      );
      const answer = this.executePermissionFetchXml(
        permissionQuery.xml,
        identity,
        { ...options, profile: 'webapi' },
        permissionQuery,
      );
      const result = { value: answer.entities };
      if (p.$count === 'true') result['@odata.count'] = answer.total_record_count;
      if (paging)
        result.paging = {
          nextOffset: answer.entities.length,
          moreRecords: answer.more_records,
          totalCount: answer.total_record_count,
        };
      Object.defineProperty(result, 'permissionQuery', { value: permissionQuery, configurable: true });
      return result;
    }
    // This explicit portal transport uses the supported scalar OData adapter to
    // expose modeled permission-expanded input to observers. Proprietary native
    // OData-to-QueryBase conversion, navigation and aggregation are not inferred.
    if (
      options.portalRequest === true &&
      !identity.admin &&
      this.state.settings.permissionMode !== 'permissive' &&
      !paging &&
      options.id == null &&
      !options.ids &&
      !options.skipPluginRead &&
      this.pluginPipeline &&
      this.pluginPipelineActive({
        entity: mapping.logicalName,
        operation: 'retrievemultiple',
        bypassCustomPlugins: options.bypassCustomPlugins === true,
        bypassStepIds: options.bypassStepIds,
      }) &&
      Object.keys(p).every((key) => ['$select', '$filter', '$orderby', '$top', '$count'].includes(key)) &&
      String(p.$top ?? '') !== '0' &&
      (p.$count === undefined || ['true', 'false'].includes(p.$count)) &&
      !Object.values(p).some((value) => String(value).includes('/'))
    ) {
      const scalarParams = { ...p };
      delete scalarParams.$count;
      const sdkQuery = odataToSdkQuery(mapping.logicalName, scalarParams, this);
      const answer = this.fetchXml(queryExpressionToFetch(sdkQuery, this), identity, {
        ...options,
        profile: 'webapi',
        returnTotal: p.$count === 'true',
      });
      const result = { value: answer.entities };
      if (p.$count === 'true') result['@odata.count'] = answer.total_record_count;
      Object.defineProperty(result, 'permissionQuery', {
        value: { ...answer.permissionQuery, transport: 'modeled-scalar-odata-adapter' },
        configurable: true,
      });
      return result;
    }
    if (
      !this.pluginPipeline ||
      !this.pluginPipelineActive({
        entity: mapping.logicalName,
        operation: 'retrievemultiple',
        bypassCustomPlugins: options.bypassCustomPlugins === true,
        bypassStepIds: options.bypassStepIds,
      })
    )
      return this.queryCore(entity, params, identity, paging, options);
    if (options.skipPluginRead) return this.queryCore(entity, params, identity, paging, options);
    const original = options.sdkQuery ?? odataToSdkQuery(mapping.logicalName, params, this);
    return this.retrieveMultipleOperation(
      mapping.logicalName,
      original,
      identity,
      (query) => {
        if (!['QueryExpression', 'QueryByAttribute'].includes(query.$type) || query.entityName !== mapping.logicalName)
          throw new DataError(
            'A RetrieveMultiple plugin cannot change the bound query table or query language.',
            501,
            'LocalPluginQueryUnsupported',
          );
        if (sameSdkQuery(query, original))
          return this.queryCore(entity, params, identity, paging, { ...options, captureRootIds: true });
        const projectedQuery = clone(query);
        const preserveFilter = sameSdkQuery(query.criteria, original.criteria);
        if (preserveFilter) projectedQuery.criteria = { operatorName: 'And', conditions: [], filters: [] };
        const converted = { ...p };
        const rewritten = sdkQueryParameters(projectedQuery);
        for (const key of ['$select', '$filter', '$orderby', '$top']) {
          if (key === '$filter' && preserveFilter) continue;
          delete converted[key];
          if (rewritten[key] !== undefined) converted[key] = rewritten[key];
        }
        if (!query.columnSet?.allColumns && !query.columnSet?.columns?.length) converted.$select = mapping.idColumn;
        if (converted.$select && !converted.$select.split(',').includes(mapping.idColumn))
          converted.$select += ',' + mapping.idColumn;
        return this.queryCore(entity, converted, identity, paging, options);
      },
      'value',
      options.sdkResponseToken,
      { ...options, preserveProperties: parseExpand(p.$expand).map((item) => item.navigation) },
    );
  }
  retrieveMultipleOperation(entity, original, identity, execute, key, responseToken, options = {}) {
    if (!this.hasOperationContext())
      return this.withOperationContext(() =>
        this.retrieveMultipleOperation(entity, original, identity, execute, key, responseToken, options),
      );
    const mapping = this.resolveMapping(entity),
      query = clone(original),
      record = { [mapping.idColumn]: '00000000-0000-0000-0000-000000000000' },
      previousReadOnly = this.pluginReadOnly;
    if (
      !identity.admin &&
      this.state.settings.permissionMode !== 'permissive' &&
      !this.rules(entity, 'read', identity).length
    )
      throw new DataError('Table permission denies read on ' + entity, 403, 'PermissionDenied');
    this.ensureReadSnapshot();
    this.pluginReadOnly = !this.pluginRollbackBoundary;
    try {
      this.pluginPipeline({
        entity,
        operation: 'retrievemultiple',
        stage: 10,
        query,
        record,
        identity,
        changedAttributes: [],
        ...(options.readInitialFrame ? { initialFrame: options.readInitialFrame } : {}),
        bypassCustomPlugins: options.bypassCustomPlugins === true,
        bypassStepIds: options.bypassStepIds,
        portalRequest: options.portalRequest === true,
      });
      if (
        options.portalRequest === true &&
        options.queryTransport !== 'source-derived-scalar-odata' &&
        query.$type === 'FetchExpression' &&
        this.observed?.fetchPreOperationSerialization?.[entity] === 'compact'
      )
        query.query = serializePermissionFetchXml(parseFetchXml(query.query), 0, false);
      this.pluginPipeline({
        entity,
        operation: 'retrievemultiple',
        stage: 20,
        query,
        record,
        identity,
        changedAttributes: [],
        bypassCustomPlugins: options.bypassCustomPlugins === true,
        bypassStepIds: options.bypassStepIds,
        portalRequest: options.portalRequest === true,
      });
      const answer = execute(query),
        collection =
          key === 'entities'
            ? fetchResultToSdkCollection(this, entity, answer, recordToSdkEntity, {
                hiddenId: answer.sdkHiddenId,
                rootColumns: query.columnSet,
              })
            : {
                $type: 'EntityCollection',
                entities: (answer[key] ?? []).map((row, index) =>
                  recordToSdkReadEntity(
                    this,
                    entity,
                    answer.sdkRootIds?.[index] === undefined
                      ? row
                      : { ...row, [mapping.idColumn]: row[mapping.idColumn] ?? answer.sdkRootIds[index] },
                    query.columnSet ?? { allColumns: false, columns: [] },
                  ),
                ),
                entityName: entity,
                minActiveRowVersion: '-1',
                moreRecords: Boolean(answer['@odata.nextLink'] ?? answer.more_records),
                pagingCookie: answer.paging_cookie ?? null,
                totalRecordCount: answer['@odata.count'] ?? answer.total_record_count ?? -1,
              };
      const responseFrame = this.pluginPipeline({
        entity,
        operation: 'retrievemultiple',
        stage: 40,
        query,
        collection,
        record,
        identity,
        changedAttributes: [],
        bypassCustomPlugins: options.bypassCustomPlugins === true,
        bypassStepIds: options.bypassStepIds,
        portalRequest: options.portalRequest === true,
      });
      handoffPluginResponse(this, 'retrievemultiple', mapping.logicalName, responseFrame, responseToken);
      if (
        collection.$type !== 'EntityCollection' ||
        !Array.isArray(collection.entities) ||
        collection.entities.some((e) => e.$type !== 'Entity' || e.logicalName !== entity)
      )
        throw new DataError(
          'RetrieveMultiple output must preserve the bound EntityCollection.',
          501,
          'LocalPluginQueryUnsupported',
        );
      // Native runs asynchronous RetrieveMultiple steps after the read, with its query and result (a message event:
      // flows and mutation observers ignore it). A read outside a transaction stages it in its own queued transaction.
      const readEvent = clone({
        target: {},
        query,
        collection,
        identity,
        frame: responseFrame ?? {},
        messageEvent: true,
        bypassCustomAsync: options.bypassCustomAsync === true,
        bypassStepIds: options.bypassStepIds,
      });
      if (this.committedEventCandidates) this.recordCommittedEvent(entity, 'retrievemultiple', record, [], readEvent);
      else if (this.commitStagers?.size)
        this.transact(() => this.recordCommittedEvent(entity, 'retrievemultiple', clone(record), [], readEvent), {
          skipSaveIfUnchanged: true,
        }).catch((error) => {
          (this.committedEventErrors ??= []).push({ code: error.code ?? 'CommitStagerError', message: error.message });
        });
      const sourceRows = answer[key] ?? [];
      const sourceById = new Map(
        sourceRows.map((row, index) => [row[mapping.idColumn] ?? answer.sdkRootIds?.[index], row]),
      );
      answer[key] = collection.entities.map((e) => {
        const source = sourceById.get(e.id),
          row = {
            ...Object.fromEntries(Object.entries(source ?? {}).filter(([, value]) => value === null)),
            ...Object.fromEntries(
              (options.preserveProperties ?? [])
                .filter((name) => Object.hasOwn(source ?? {}, name))
                .map((name) => [name, clone(source[name])]),
            ),
            ...sdkValueToRecord(e),
          };
        // The SDK main result includes its primary Attribute independently of
        // the public transport's selected fields. Preserve that projection
        // while retaining a deliberate changed primary output from a plugin.
        if ((answer.sdkHiddenId || (source && !own(source, mapping.idColumn))) && equal(row[mapping.idColumn], e.id))
          delete row[mapping.idColumn];
        return row;
      });
      Object.defineProperty(answer, 'sdkCollection', { value: clone(collection), configurable: true });
      if (key === 'value') {
        if (Object.hasOwn(answer, '@odata.count')) answer['@odata.count'] = collection.totalRecordCount;
        if (collection.moreRecords !== Boolean(answer['@odata.nextLink']))
          throw new DataError(
            'Changing OData continuation requires an explicit paging adapter.',
            501,
            'LocalPluginQueryUnsupported',
          );
      } else {
        answer.more_records = collection.moreRecords;
        answer.paging_cookie = collection.pagingCookie;
        answer.total_record_count = collection.totalRecordCount;
      }
      return answer;
    } finally {
      this.pluginReadOnly = previousReadOnly;
    }
  }
  queryCore(entity, params = {}, identity = {}, paging, options = {}) {
    const m = this.resolveMapping(entity);
    const p = params instanceof URLSearchParams ? Object.fromEntries(params) : { ...params };
    if (p.fetchXml || p.fetchxml) {
      const r = this.fetchXml(p.fetchXml ?? p.fetchxml, identity, options);
      return { value: r.entities, '@odata.count': r.total_record_count };
    }
    const dialect = options.dialect ?? 'extended';
    const aliases = Object.fromEntries(Object.entries(p).filter(([key]) => key.startsWith('@')));
    for (const key of Object.keys(p)) {
      if (key.startsWith('@')) {
        continue;
      }
      if (
        key.startsWith('$') &&
        !['$filter', '$select', '$expand', '$orderby', '$top', '$skip', '$count', '$apply'].includes(key)
      )
        throw new DataError(`Unsupported OData option ${key}`, 400, 'UnsupportedQuery');
    }
    if (
      !identity.admin &&
      this.state.settings.permissionMode !== 'permissive' &&
      !this.rules(m.logicalName, 'read', identity).length
    )
      throw new DataError(`Table permission denies read on ${entity}`, 403, 'PermissionDenied', {
        operation: 'read',
        table: m.logicalName,
      });
    const queryOptions = { dialect, aliases };
    const ctx = this.queryContext(identity, { ...options, dialect });
    // Single-record and id-list reads find their rows through the primary-key index before
    // the row-security filter, instead of filtering the whole table.
    const subset =
      options.id != null || options.ids
        ? this.primaryKeySubset(m, options.id != null ? [options.id] : [...options.ids])
        : null;
    let rows = ctx.readRows(m.logicalName, undefined, subset ?? undefined);
    if (options.backendRowFilter) rows = rows.filter((row) => options.backendRowFilter(clone(row)) === true);
    // Single-record and navigation routes restrict the readable rows first.
    if (options.id != null) rows = rows.filter((row) => equal(row[m.idColumn], options.id));
    if (isElastic(m) && Object.hasOwn(options, 'partitionId'))
      rows = rows.filter((row) => samePartition(row.partitionid, options.partitionId));
    if (options.ids) {
      const wanted = new Set([...options.ids].map(comparable));
      rows = rows.filter((row) => wanted.has(comparable(row[m.idColumn])));
    }
    if (p.$filter != null && String(p.$filter).trim() !== '')
      rows = rows.filter(compileODataPredicate(parseODataExpression(p.$filter, queryOptions), m, ctx));
    // Ordering on a calculated column over a parent or another calculated column is
    // ignored without an error.
    const order = parseOrderBy(p.$orderby, queryOptions).filter(
      (spec) => spec.path.length !== 1 || this.sortableColumn(m.logicalName, spec.path[0]),
    );
    const sortOptions = {
      mapping: m,
      valueOf: (row, path) => this.pathValue(ctx, m, row, path),
      definition: (path) => this.pathDefinition(ctx, m, path),
      lookupName: ctx.lookupName,
      collation: ctx.settings.collation,
    };
    if (p.$apply) {
      for (const key of ['$select', '$expand', '$skip'])
        if (own(p, key)) throw new DataError(`OData $apply can't be combined with ${key}`, 400, 'UnsupportedQuery');
      const steps = parseApply(p.$apply, queryOptions);
      const applied = evaluateApply(steps, rows, {
        ...ctx,
        mapping: m,
        pathValue: (row, segments) => this.pathValue(ctx, m, row, segments),
        pathDefinition: (segments) => this.pathDefinition(ctx, m, segments),
        targetLogicalName: (segments) => this.pathMapping(ctx, m, segments).logicalName,
      });
      let values = applied.rows;
      if (order.length) {
        const aggregateAliases = new Set(
          steps.flatMap((step) => (step.aggregates ?? []).map((aggregate) => aggregate.alias)),
        );
        for (const spec of order)
          if (aggregateAliases.has(spec.path.join('/')))
            throw new DataError(
              'The query node SingleValueOpenPropertyAccess is not supported',
              400,
              'UnsupportedQuery',
            );
        values = sortRows(values, order, {
          ...sortOptions,
          valueOf: (row, path) => row[path.join('/')],
          definition: (path) => (path.length === 1 ? ctx.definition(m.logicalName, path[0]) : undefined),
          tieBreak: false,
        });
      }
      // A Dataverse groupby without $orderby answers its single-column groups in ascending key order (false before true).
      if (!order.length && options.dialect === 'dataverse') {
        const groupKeys = steps
          .filter((step) => step.kind === 'groupby')
          .flatMap((step) => step.properties ?? [])
          .filter((path) => path.length === 1)
          .map((path) => ({ path, descending: false }));
        if (groupKeys.length)
          values = sortRows(values, groupKeys, {
            ...sortOptions,
            valueOf: (row, path) => row[path.join('/')],
            definition: (path) => ctx.definition(m.logicalName, path[0]),
            tieBreak: false,
          });
      }
      if (p.$top != null) values = values.slice(0, boundedInt(p.$top, '$top'));
      return { value: clone(values) };
    }
    const count = rows.length,
      publicCount = paging ? Math.min(count, 5000) : count;
    // A continuation that names the previous page's last row resumes after that row (key-set
    // paging), so a later page neither re-sorts the whole result nor shifts after a concurrent write.
    const keyset =
      paging?.after != null && !isElastic(m)
        ? keysetPage(rows, order, sortOptions, paging.after, paging.pageSize)
        : null;
    if (keyset) rows = keyset.rows;
    // Public pages always have a deterministic primary-key tie breaker.
    else if (order.length || paging)
      rows = sortRows(rows, order, {
        ...sortOptions,
        tieBreak: Boolean(paging),
      });
    const skip = keyset ? keyset.before : paging ? paging.offset : boundedInt(p.$skip ?? 0, '$skip'),
      totalLimit = paging ? Math.min(count, p.$top == null ? count : boundedInt(p.$top, '$top')) : rows.length,
      top = paging
        ? Math.min(paging.pageSize, Math.max(totalLimit - skip, 0))
        : p.$top == null
          ? rows.length
          : boundedInt(p.$top, '$top');
    rows = keyset ? rows.slice(0, top) : rows.slice(skip, skip + top);
    const select = parseSelect(p.$select);
    const expand = this.prepareExpand(ctx, m, parseExpand(p.$expand), queryOptions);
    const values = rows.map((row) => this.projectRow(ctx, m, row, select, expand, options.includeKeys === true));
    const answer = {
      value: clone(values),
      ...(String(p.$count) === 'true' ? { '@odata.count': publicCount } : {}),
      ...(paging
        ? {
            paging: {
              nextOffset: skip + values.length,
              moreRecords: skip + values.length < totalLimit,
              totalCount: count,
              // The page's first and last order-column values (cursorText), which the paging cookie carries so the
              // next page resumes after the last row's values (keysetPage), not after a row that may be gone.
              ...(rows.length && order.length
                ? {
                    order: order.map((spec) => ({
                      name: spec.path.join('/'),
                      first: cursorText(sortOptions.valueOf(rows[0], spec.path)),
                      last: cursorText(sortOptions.valueOf(rows.at(-1), spec.path)),
                    })),
                  }
                : {}),
            },
          }
        : {}),
    };
    if (options.captureRootIds)
      Object.defineProperty(answer, 'sdkRootIds', { value: rows.map((row) => row[m.idColumn]) });
    return answer;
  }
  normalizeRecord(mapping, data, identity = {}) {
    const SYSTEM_BIND_NAVIGATIONS = new Set([
      'ownerid',
      'owninguser',
      'owningteam',
      'owningbusinessunit',
      'createdby',
      'modifiedby',
      'createdonbehalfby',
      'modifiedonbehalfby',
      'transactioncurrencyid',
    ]);
    const row = clone(data);
    for (const [key, value] of Object.entries(row)) {
      safeName(key.replace(/@odata\.bind$/, ''));
      if (key.endsWith('@odata.bind')) {
        const navigation = key.slice(0, -11),
          relationships = this.relationshipsFor(mapping, identity),
          relationship = relationships[navigation],
          field = relationship?.from ?? navigation;
        // Navigation names are case-sensitive: a bind on a name no relationship declares (a column name, another casing) is
        // the OData undeclared-property error, as the Web API payload check answers it. The system lookups every table
        // carries (owner, audit, currency) bind on their column name. ponytail: a mapping that declares no relationship for
        // a lookup column (no navigation metadata to judge by) keeps binding on that column's exact name; a relationship
        // over the column makes its navigation the only name.
        // A lookup column: typed so in the mapping, or named by a partner one-to-many relationship of another table.
        const lookupKind =
          !relationship &&
          (['lookup', 'customer', 'owner'].includes(
            String(
              mapping.fields?.[navigation]?.dataverseType ?? mapping.fields?.[navigation]?.type ?? '',
            ).toLowerCase(),
          ) ||
            Object.values(this.state.mappings ?? {}).some((other) =>
              Object.values(other?.relationships ?? {}).some(
                (rel) =>
                  rel?.many === true && !rel.intersect && rel.to === navigation && rel.entity === mapping.logicalName,
              ),
            ));
        const undeclaredLookup = lookupKind && !Object.values(relationships).some((rel) => rel?.from === navigation);
        if (!relationship && !SYSTEM_BIND_NAVIGATIONS.has(navigation) && !undeclaredLookup)
          throw new DataError(
            `Error identified in Payload provided by the user for Entity :'${mapping.entitySet ?? mapping.logicalName}'  ---->  InnerException : Microsoft.OData.ODataException: An undeclared property '${navigation}' which only has property annotations in the payload but no property value was found in the payload. In OData, only declared navigation properties and declared named streams can be represented as properties without values`,
            400,
            'InvalidLookup',
            { innerCode: '0x80048d19' },
          );
        if (relationship?.many) throw new DataError(`Collection binding ${key} is not supported`, 400, 'InvalidLookup');
        if (Object.hasOwn(row, field))
          throw new DataError(
            `Lookup field ${field} and navigation binding cannot both be supplied`,
            400,
            'InvalidLookup',
          );
        if (value === null) {
          row[field] = null;
          if (relationship && isElastic(this.resolveMapping(relationship.entity))) row[`${field}pid`] = null;
          delete row[key];
          continue;
        }
        const reference = parseEntityReference(value);
        if (!reference) throw new DataError(`Invalid lookup binding ${key}`);
        const target = this.resolveMapping(reference.set);
        if (relationship && relationship.entity !== target.logicalName)
          throw new DataError(`Lookup binding target does not match navigation ${navigation}`, 400, 'InvalidLookup');
        const hit =
          isElastic(target) && !reference.id.includes('=')
            ? this.get(
                target.logicalName,
                reference.id,
                { admin: true },
                { partitionId: row[`${field}pid`], skipPluginRead: true },
              )
            : this.findByKey(target, reference.id);
        // Elastic lookups without the custom partition are allowed to persist, but remain unresolved.
        // Never substitute a record from another partition (or its display name).
        if (!hit && isElastic(target) && !reference.id.includes('=') && row[`${field}pid`] == null) {
          row[field] = { id: reference.id, logical_name: target.logicalName, partitionid: null, name: '' };
          row[`${field}pid`] = null;
          delete row[key];
          continue;
        }
        if (!hit) throw new DataError(`Lookup target ${value} does not exist`, 400, 'InvalidLookup');
        row[field] = {
          id: hit[target.idColumn],
          logical_name: target.logicalName,
          name: primaryNameValue(target, hit) ?? '',
          ...(isElastic(target) ? { partitionid: hit.partitionid ?? null } : {}),
        };
        if (isElastic(target)) row[`${field}pid`] = hit.partitionid ?? null;
        delete row[key];
      }
    }
    return row;
  }
  /**
   * Resolve a key segment: a primary key (GUID with or without braces) or an
   * alternate key (attr='v',attr2=1) declared in mapping.alternateKeys.
   */
  findByKey(mapping, key) {
    const rows = this.tableRows(mapping.logicalName);
    const parts = parseKeySegment(key);
    if (!parts) return rows[this.rowIndex(mapping, rows, key)];
    const names = Object.keys(parts).sort();
    if (isElastic(mapping) && names.length === 1 && names[0] === mapping.idColumn)
      return rows[this.rowIndex(mapping, rows, parts[mapping.idColumn])];
    // Only an Active key (its index job succeeded) resolves rows; Pending and Failed keys do not exist for lookups.
    const declared = (mapping.alternateKeys ?? [])
      .filter((alternate) => (alternate.indexStatus ?? 'Active') === 'Active')
      .some((alternate) => {
        const attributes = (alternate.attributes ?? alternate.keyAttributes ?? [])
          .map((name) => String(name).toLowerCase())
          .sort();
        return attributes.length === names.length && attributes.every((name, index) => name === names[index]);
      });
    if (!declared && !(names.length === 1 && names[0] === mapping.idColumn))
      throw new DataError(
        `The key attribute(s) ${names.join(', ')} don't match an alternate key declared for ${mapping.logicalName}.`,
        400,
        'InvalidKey',
        { innerCode: '0x80040203' },
      );
    const collation = this.querySettings().collation;
    const kinds = Object.fromEntries(
      names.map((name) => [name, fieldKind(this.fieldDefinition(mapping.logicalName, name))]),
    );
    const matches = (row) =>
      names.every((name) =>
        isElastic(mapping) && name === 'partitionid'
          ? samePartition(row[name], parts[name])
          : valuesEqual(field(row, name), parts[name], { collation, kind: kinds[name] }),
      );
    // Within one transaction (UpsertMultiple, key upserts) candidates come from the key-segment index.
    const literal = names.map((name) => keySegmentBucket(parts[name], collation, kinds[name]));
    if (!isElastic(mapping) && literal.every((bucket) => typeof bucket === 'string')) {
      const name = `ks\u0000${JSON.stringify([collation, names, kinds])}`;
      const index = this.rowKeyIndex(rows, name, keySegmentOf(names, collation, kinds), { scoped: true, wild: true });
      if (index && !index.linear) {
        const bucketed = index.get(JSON.stringify(literal));
        const candidates = index.wild.length
          ? [...new Set([...bucketed, ...index.wild])].sort((a, b) => a - b)
          : bucketed;
        // Validity check: every bucketed candidate must still match; otherwise rebuild and scan.
        let first;
        for (const position of candidates) {
          const row = rows[position];
          if (row !== undefined && matches(row)) {
            first = row;
            break;
          }
          if (bucketed.includes(position)) {
            first = null;
            break;
          }
        }
        if (first !== null) return first;
        this.dropRowKeyIndex(rows, name);
      }
    }
    return rows.find(matches);
  }
  evaluate(expr, context) {
    if (typeof expr === 'string' && expr.startsWith('$')) {
      const [root, ...parts] = expr.slice(1).split('.');
      return parts.reduce((v, k) => v?.[k], context[root]);
    }
    if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return clone(expr);
    if (own(expr, 'literal')) return clone(expr.literal);
    const args = (expr.args ?? []).map((a) => this.evaluate(a, context));
    switch (expr.op) {
      case 'concat':
        return args.map((a) => a ?? '').join('');
      case 'coalesce':
        return args.find((v) => v != null && v !== '');
      case 'lower':
        return String(args[0] ?? '').toLowerCase();
      case 'upper':
        return String(args[0] ?? '').toUpperCase();
      case 'sum':
        return args.some(isExactNumeric)
          ? sumNumeric(args.map((a) => a ?? 0))
          : args.reduce((n, a) => n + Number(a ?? 0), 0);
      case 'multiply':
        return args.some(isExactNumeric)
          ? multiplyNumeric(args.map((a) => a ?? 0))
          : args.reduce((n, a) => n * Number(a ?? 0), 1);
      case 'uuid':
        return this.ids.uuid();
      case 'sequence': {
        const scope = safeName(String(args[0]));
        const prefix = String(args[1] ?? '');
        const width = Number(args[2] ?? 6);
        if (!/^[a-z0-9 _-]{0,32}$/i.test(prefix) || !Number.isInteger(width) || width < 1 || width > 12)
          throw new DataError('Plugin sequence requires a bounded prefix and width', 400, 'InvalidPlugin');
        const counters = (this.state.settings.pluginSequences ??= {});
        const next = Number(counters[scope] ?? 0) + 1;
        if (!Number.isSafeInteger(next) || next >= 10 ** width)
          throw new DataError('Plugin sequence exhausted configured width', 400, 'InvalidPlugin');
        counters[scope] = next;
        return prefix + String(next).padStart(width, '0');
      }
      case 'now':
        return new Date(this.clock.now()).toISOString();
      case 'split':
        return String(args[0] ?? '')
          .split(args[1] ?? ',')
          .map((s) => s.trim())
          .filter(Boolean);
      case 'join':
        if (!Array.isArray(args[0])) throw new DataError('Plugin join requires an array', 400, 'InvalidPlugin');
        return args[0].map(scalar).join(args[1] ?? ', ');
      case 'length':
        if (!Array.isArray(args[0])) throw new DataError('Plugin length requires an array', 400, 'InvalidPlugin');
        return args[0].length;
      case 'lookup': {
        const record = this.get(safeName(String(args[0])), scalar(args[1]), context.identity, { skipPluginRead: true });
        if (!record) throw new DataError('Plugin lookup target does not exist', 400, 'InvalidLookup');
        return clone(args[2] ? field(record ?? {}, safeName(String(args[2]))) : record);
      }
      case 'related': {
        const mapping = this.resolveMapping(safeName(String(args[0])));
        const relationshipName = safeName(String(args[2]));
        const relationship = mapping.relationships?.[relationshipName];
        if (!relationship)
          throw new DataError('Plugin relationship is not declared in entity metadata', 400, 'MissingRelationship');
        const multiple = Array.isArray(args[1]),
          ids = multiple ? args[1] : [args[1]],
          result = [];
        if (ids.length > 1024) throw new DataError('Plugin related exceeds 1024 parent records', 400, 'InvalidPlugin');
        const targets = this.rows(relationship.entity, context.identity);
        // Indexed relationship lookup (direct or through the intersect table)
        // instead of testing every target against every intersect row.
        const relatedIndex = this.permissionMemo();
        const targetLogical = this.resolveMapping(relationship.entity).logicalName;
        for (const id of ids) {
          const parent = this.get(mapping.logicalName, scalar(id), context.identity, { skipPluginRead: true });
          if (!parent) throw new DataError('Plugin relationship parent does not exist', 400, 'InvalidLookup');
          const linked = new Set(relatedIndex.related(parent, relationship, targetLogical));
          for (const row of targets.filter((row) => linked.has(row))) {
            const value = args[3] ? field(row, safeName(String(args[3]))) : row;
            result.push(multiple ? { parentId: parent[mapping.idColumn], record: value } : value);
          }
          if (result.length > 1024) throw new DataError('Plugin related exceeds 1024 records', 400, 'InvalidPlugin');
        }
        return clone(result);
      }
      case 'find': {
        const mapping = this.resolveMapping(safeName(String(args[0])));
        const matches = Object.entries(expr.match ?? {}).map(([key, value]) => [
          safeName(key),
          this.evaluate(value, context),
        ]);
        if (!matches.length) throw new DataError('Plugin find requires explicit matching fields', 400, 'InvalidPlugin');
        const record = this.tableRows(mapping.logicalName).find(
          (row) =>
            matches.every(([key, value]) => equal(field(row, key), value)) &&
            this.allowed(mapping.logicalName, 'read', row, context.identity),
        );
        return clone(record ? (args[1] ? field(record, safeName(String(args[1]))) : record) : null);
      }
      case 'findMany': {
        const mapping = this.resolveMapping(safeName(String(args[0])));
        const matches = Object.entries(expr.match ?? {}).map(([key, value]) => [
          safeName(key),
          this.evaluate(value, context),
        ]);
        if (!matches.length)
          throw new DataError('Plugin findMany requires explicit matching fields', 400, 'InvalidPlugin');
        const records = this.tableRows(mapping.logicalName).filter(
          (row) =>
            matches.every(([key, value]) =>
              Array.isArray(value)
                ? value.some((candidate) => equal(field(row, key), candidate))
                : equal(field(row, key), value),
            ) && this.allowed(mapping.logicalName, 'read', row, context.identity),
        );
        if (records.length > 1024) throw new DataError('Plugin findMany exceeds 1024 records', 400, 'InvalidPlugin');
        return clone(records.map((row) => (args[1] ? field(row, safeName(String(args[1]))) : row)));
      }
      case 'reference': {
        const mapping = this.resolveMapping(safeName(String(args[0])));
        const id = scalar(args[1]);
        const record =
          mapping.logicalName === context.entity && equal(id, context.record[mapping.idColumn])
            ? context.record
            : this.get(mapping.logicalName, id, context.identity, { skipPluginRead: true });
        if (!record) throw new DataError('Plugin reference target does not exist', 400, 'InvalidLookup');
        return {
          id,
          logical_name: mapping.logicalName,
          name: primaryNameValue(mapping, record) ?? '',
        };
      }
      default: {
        // Operators contributed by data packs (lib/extensions.mjs).
        const operator = expressionOperator(expr.op);
        if (operator)
          return operator({
            store: this,
            context,
            args,
            expression: expr,
            fail: (message, status, code) => {
              throw new DataError(message, status, code);
            },
          });
        throw new DataError(`Unsupported plugin expression ${expr.op}`, 400, 'InvalidPlugin');
      }
    }
  }
  applyPlugins(entity, operation, row, previous, identity) {
    const context = {
      entity,
      record: row,
      previous: previous ?? {},
      identity,
      now: new Date(this.clock.now()).toISOString(),
    };
    const secondary = [];
    for (const p of this.state.plugins.filter(
      (p) =>
        p.enabled !== false &&
        (p.entity === entity || p.entity === '*') &&
        (p.operations ?? ['create', 'update']).includes(operation),
    )) {
      if (p.when && !compileFilter(p.when)(row)) continue;
      for (const [key, expr] of Object.entries(p.defaults ?? {}))
        if (row[key] == null) {
          safeName(key);
          row[key] = this.evaluate(expr, context);
        }
      for (const [key, expr] of Object.entries(p.set ?? {})) {
        safeName(key);
        row[key] = this.evaluate(expr, context);
      }
      for (const v of p.validate ?? []) {
        const value = field(row, v.field ?? '');
        let valid = true;
        if (v.required) valid = value != null && value !== '';
        if (v.pattern) valid = valid && new RegExp(v.pattern).test(String(value ?? ''));
        if (v.min != null) valid = valid && Number(value) >= v.min;
        if (v.max != null) valid = valid && Number(value) <= v.max;
        if (v.oneOf) valid = valid && v.oneOf.some((x) => equal(x, value));
        if (v.assert) valid = valid && compileFilter(v.assert)(row);
        if (v.unique) {
          const m = this.resolveMapping(entity);
          valid =
            valid &&
            !(this.state.tables[entity] ?? []).some(
              (r) => !equal(r[m.idColumn], row[m.idColumn]) && equal(field(r, v.field), value),
            );
        }
        if (!valid)
          throw new DataError(
            v.message ?? `Plugin ${p.id ?? 'validation'} rejected ${v.field ?? 'record'}`,
            400,
            'PluginValidation',
            {
              innerCode: String(v.innerCode ?? '0x80040265').toLowerCase(),
              ...(typeof v.message === 'string' && v.message.trim() ? { declaredValidationMessage: true } : {}),
            },
          );
      }
      secondary.push(...(p.secondary ?? []).map((action) => ({ action, context })));
    }
    return secondary;
  }
  applySecondary(effects) {
    for (const { action, context } of effects) {
      if (action.foreach) {
        const values = this.evaluate(action.foreach, context);
        if (!Array.isArray(values) || values.length > 1024)
          throw new DataError('Plugin foreach requires an array of at most 1024 items', 400, 'InvalidPlugin');
        const { foreach, ...nested } = action;
        this.applySecondary(
          values.map((item, index) => ({
            action: nested,
            context: { ...context, item, index },
          })),
        );
        continue;
      }
      const m = this.resolveMapping(action.entity);
      const targets = (this.state.tables[m.logicalName] ??= []);
      const values = Object.fromEntries(
        Object.entries(action.set ?? {}).map(([k, v]) => [safeName(k), this.evaluate(v, context)]),
      );
      if (action.operation === 'create') {
        if (action.match) {
          const matches = Object.fromEntries(
            Object.entries(action.match).map(([k, v]) => [k, this.evaluate(v, context)]),
          );
          if (targets.some((target) => Object.entries(matches).every(([k, v]) => equal(field(target, k), v)))) continue;
        }
        this.insertRow(m.logicalName, targets, { [m.idColumn]: this.ids.uuid(), ...values });
      } else if (action.operation === 'update' || action.operation === 'delete') {
        if (!action.match) throw new DataError('Secondary update/delete requires match');
        const matches = Object.fromEntries(
          Object.entries(action.match).map(([k, v]) => [k, this.evaluate(v, context)]),
        );
        if (
          action.requireMatch &&
          !targets.some((target) => Object.entries(matches).every(([key, value]) => equal(field(target, key), value)))
        )
          throw new DataError('The backend action cannot find a matching related record', 400, 'InvalidPlugin');
        for (let i = targets.length - 1; i >= 0; i--)
          if (Object.entries(matches).every(([k, v]) => equal(field(targets[i], k), v))) {
            if (action.operation === 'delete') this.removeRow(m.logicalName, targets, i);
            else this.mutateRow(m.logicalName, targets, i, values);
          }
      } else throw new DataError(`Unsupported secondary operation ${action.operation}`, 400, 'InvalidPlugin');
    }
  }
  pluginBindingInput(mapping, input, target, identity) {
    const relationships = this.relationshipsFor(mapping, identity);
    return {
      ...Object.fromEntries(
        Object.entries(input).filter(([key]) => {
          const attribute = key.endsWith('@odata.bind')
            ? (relationships[key.slice(0, -11)]?.from ?? key.slice(0, -11))
            : key;
          return own(target, attribute);
        }),
      ),
      ...target,
    };
  }
  validateBindings(mapping, input, row, identity, previous = null, nativeContactAssociation = null) {
    const relationships = this.relationshipsFor(mapping, identity);
    if (this.state.settings.associationPermissions === 'enforce')
      for (const key of Object.keys(input).filter((key) => key.endsWith('@odata.bind')))
        if (!relationships[key.slice(0, -11)])
          throw new DataError('Lookup binding requires a known navigation relationship', 400, 'MissingRelationship');
    const changed = new Set(
      Object.keys(input).map((key) =>
        key.endsWith('@odata.bind') ? (relationships[key.slice(0, -11)]?.from ?? key.slice(0, -11)) : key,
      ),
    );
    for (const relationship of Object.values(relationships)) {
      // Primary-key joins describe table inheritance, not a visitor-authored
      // lookup. The generated key is visible to plug-ins before those related
      // platform rows exist and must not be admitted as an association.
      if (relationship.many === true || relationship.from === mapping.idColumn || !changed.has(relationship.from))
        continue;
      const id = scalar(field(row, relationship.from) ?? field(previous ?? {}, relationship.from));
      if (id == null) continue;
      const targetMapping = this.resolveMapping(relationship.entity);
      // Polymorphic lookups (annotation objectid, customerid, regardingobjectid) have one
      // relationship per target table: only the one naming the bound table applies .
      const bound = field(row, relationship.from) ?? field(previous ?? {}, relationship.from);
      if (
        bound?.logical_name &&
        String(bound.logical_name).toLowerCase() !== String(targetMapping.logicalName).toLowerCase()
      )
        continue;
      const candidates = this.tableRows(targetMapping.logicalName);
      const target =
        candidates[
          this.rowIndex(targetMapping, candidates, id, {
            partitionId: row[`${relationship.from}pid`] ?? bound?.partitionid,
          })
        ];
      if (!target && isElastic(targetMapping) && row[`${relationship.from}pid`] == null && bound?.partitionid == null)
        continue;
      if (!target) throw new DataError('Lookup target does not exist', 400, 'InvalidLookup');
      // A configured form's server-owned current-contact stamp is not an
      // explicit visitor lookup. Target existence, other fields and plugin
      // changes still follow the same validation path.
      if (!(
        nativeContactAssociation &&
        String(relationship.from).toLowerCase() === nativeContactAssociation.column &&
        targetMapping.logicalName === 'contact' &&
        String(id).toLowerCase() === nativeContactAssociation.contactId
      ))
        this.assertBindingTarget(mapping, row, targetMapping, target, identity);
    }
  }
  /**
   * Binding a lookup (create, update or $ref) needs Append on the source and
   * AppendTo on the target (Power Pages 90040105/90040106); read on the target
   * record isn't required. Exported portal grants rely on this: global
   * AppendTo-only contact permissions let co-authors from other
   * organisations be added. Without association enforcement, the binding
   * still needs read or AppendTo access to the target.
   */
  assertBindingTarget(mapping, row, targetMapping, target, identity) {
    if (this.state.settings.associationPermissions === 'enforce') {
      this.assertAllowed(mapping.logicalName, 'append', row, identity, targetMapping.logicalName);
      this.assertAllowed(targetMapping.logicalName, 'appendTo', target, identity, mapping.logicalName);
      return;
    }
    if (
      !this.allowed(targetMapping.logicalName, 'read', target, identity) &&
      !this.allowed(targetMapping.logicalName, 'appendTo', target, identity)
    )
      this.assertAllowed(targetMapping.logicalName, 'appendTo', target, identity, mapping.logicalName);
  }
  /** Dataverse row version for @odata.etag and If-Match checks. */
  etag(row) {
    if (row?.versionnumber != null) return `W/"${scalar(row.versionnumber)}"`;
    // Rows without a stored version get a content-derived version that changes
    // whenever the row changes (Dataverse increments versionnumber instead).
    const digest = createHash('sha256')
      .update(JSON.stringify(row ?? {}))
      .digest('hex');
    return `W/"${parseInt(digest.slice(0, 13), 16)}"`;
  }
  /**
   * Alternate keys (mapping.alternateKeys: [{ name, attributes }]) are unique
   * indexes in Dataverse. Keys with an empty column are not compared here.
   */
  assertAlternateKeys(mapping, row, rows, ownIndex) {
    const keys = activeAlternateKeys(mapping);
    if (!keys.length) return;
    const collation = this.querySettings().collation;
    for (const key of keys) {
      const attributes = alternateKeyAttributes(key);
      if (!attributes.length) continue;
      const values = alternateKeyValues(row, attributes);
      if (values.some((value) => value == null || value === '')) continue;
      // Within one transaction the key-tuple index makes bulk creates and key upserts O(1) per row.
      const kinds = alternateKeyKinds(mapping, attributes);
      const name = `ak\u0000${JSON.stringify([collation, attributes, kinds])}`,
        keyOf = alternateKeyOf(attributes, collation, kinds),
        wanted = keyOf(row);
      const index = this.rowKeyIndex(rows, name, keyOf, { scoped: true });
      const candidates = index?.get(wanted);
      if (
        candidates &&
        candidates.every((position) => rows[position] !== undefined && keyOf(rows[position]) === wanted)
      ) {
        const clash = candidates.some(
          (position) => position !== ownIndex && !equal(rows[position][mapping.idColumn], row[mapping.idColumn]),
        );
        if (clash) throw duplicateAlternateKey(key, attributes, values);
        continue;
      }
      if (index) this.dropRowKeyIndex(rows, name);
      const clash = rows.some(
        (other, index) =>
          index !== ownIndex && !equal(other[mapping.idColumn], row[mapping.idColumn]) && keyOf(other) === wanted,
      );
      if (clash) throw duplicateAlternateKey(key, attributes, values);
    }
  }
  /** If-Match / If-None-Match semantics of Dataverse PATCH, PUT and DELETE. */
  assertPrecondition(mapping, row, { ifMatch, ifNoneMatch } = {}) {
    if (ifNoneMatch != null && String(ifNoneMatch).trim() === '*' && row)
      throw new DataError('A record with matching key values already exists.', 412, 'PreconditionFailed', {
        innerCode: '0x80040237',
      });
    if (ifMatch == null || !row) return;
    const wanted = String(ifMatch)
      .split(',')
      .map((tag) => tag.trim());
    if (wanted.includes('*')) return;
    if (!wanted.includes(this.etag(row)))
      throw new DataError(
        "The version of the existing record doesn't match the RowVersion property provided.",
        412,
        'PreconditionFailed',
        { innerCode: '0x80060882' },
      );
  }
  /** All field definitions for a table (explicit mapping plus caller metadata). */
  fieldDefinitions(logical, metadata) {
    let mapping;
    try {
      mapping = this.resolveMapping(logical);
    } catch {
      mapping = null;
    }
    const external = typeof metadata === 'function' ? metadata(mapping?.logicalName ?? logical) : null;
    return {
      ...(mapping?.fieldMetadata ?? {}),
      ...(mapping?.fields ?? {}),
      ...(external ?? {}),
    };
  }
  /** Autonumber columns follow AutoNumberFormat with a transactional counter (seed 1000). */
  applyAutoNumbers(mapping, row, options = {}) {
    for (const [name, definition] of Object.entries(this.fieldDefinitions(mapping.logicalName, options.metadata))) {
      const format = definition?.autoNumberFormat;
      if (!format || (row[name] != null && row[name] !== '')) continue;
      const counters = (this.state.settings.autoNumberSequences ??= {});
      const key = `${mapping.logicalName}.${name}`;
      const value = Number(counters[key] ?? definition.autoNumberSeed ?? 1000);
      if (!Number.isSafeInteger(value)) throw new DataError('Autonumber sequence is invalid', 400, 'InvalidAutoNumber');
      counters[key] = value + 1;
      let random = 0;
      row[name] = format
        .replace(/\{SEQNUM:(\d+)\}/g, (_all, width) => String(value).padStart(Number(width), '0'))
        .replace(/\{RANDSTRING:(\d+)\}/g, (_all, width) => {
          const length = Number(width);
          if (length < 1 || length > 6)
            throw new DataError('Invalid Argument', 400, 'InvalidAutoNumber', {
              innerCode: '0x80040203',
            });
          // Deterministic stand-in for Dataverse's random segment.
          const digest = createHash('sha256').update(`${key}\u0000${value}\u0000${random++}`).digest();
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          return Array.from(digest.subarray(0, length), (byte) => alphabet[byte % alphabet.length]).join('');
        })
        .replace(/\{DATETIMEUTC:([^}]+)\}/g, (_all, pattern) => formatDotNetDate(this.clock.now(), pattern, 0));
    }
  }
  /**
   * Typed Web API payload validation from field metadata: Dataverse rejects
   * wrong JSON types, stores empty text as null, enforces text MaxLength,
   * rounds decimals to their precision and stores UTC instants.
   */
  coerceRecord(mapping, row, options = {}) {
    for (const [key, value] of Object.entries(row)) {
      if (key.includes('@') || value == null) continue;
      const definition = this.fieldDefinition(mapping.logicalName, key, options.metadata);
      if (!definition) {
        if (isExactNumeric(value))
          throw new DataError(
            'Exact numeric storage requires imported numeric column metadata for ' + mapping.logicalName + '.' + key,
            501,
            'NumericMetadataRequired',
          );
        continue;
      }
      row[key] = coerceValue(mapping.logicalName, key, value, definition, {
        ...options,
        numericLexeme: options.odataNumberLexemes?.[key],
      });
    }
    return row;
  }
  /** Separate deep-insert payloads and collection binds from scalar columns. */
  splitDeepInsert(mapping, data, identity = {}) {
    const input = {},
      nested = [],
      collectionBinds = [],
      relationships = this.relationshipsFor(mapping, identity);
    for (const [key, value] of Object.entries(data ?? {})) {
      if (key.endsWith('@odata.bind')) {
        const navigation = key.slice(0, -11),
          rel = relationships[navigation];
        if (Array.isArray(value)) {
          if (!rel || rel.many === false)
            throw new DataError(
              `Collection binding ${key} requires a collection-valued navigation property`,
              400,
              'InvalidLookup',
            );
          collectionBinds.push({ navigation, rel, refs: value });
          continue;
        }
        input[key] = value;
        continue;
      }
      const rel = relationships[key];
      if (rel && value && typeof value === 'object' && !(own(value, 'id') && own(value, 'logical_name'))) {
        nested.push({ navigation: key, rel, value });
        continue;
      }
      input[key] = value;
    }
    return { input, nested, collectionBinds };
  }
  createRecord(entity, data, identity = {}, options = {}) {
    return this.runRecordSteps(this.createSteps(entity, data, identity, options));
  }
  /** createRecord on the asynchronous pipeline (awaitRecordSteps): a promise of the created row. */
  createRecordAsync(entity, data, identity = {}, options = {}) {
    return this.awaitRecordSteps(this.createSteps(entity, data, identity, options));
  }
  *createSteps(entity, data, identity = {}, options = {}) {
    const inherited = this.pluginInTransaction;
    try {
      return yield* this.createStepsCore(entity, data, identity, options);
    } finally {
      this.pluginInTransaction = inherited;
    }
  }
  *createStepsCore(entity, data, identity = {}, options = {}) {
    const m = this.resolveMapping(entity);
    // Entity.Id, response capture and derived source columns belong to this
    // one message. Each deep-insert child has its own identity and Attributes.
    const childOptions = { ...options };
    delete childOptions.sdkCreateId;
    delete childOptions.sdkResponseToken;
    delete childOptions.derivedCreateColumns;
    delete childOptions.authorizeEffectiveWrite;
    delete childOptions.afterPreValidation;
    const nativeContactAssociation = takeNativeFormContactAssociation(m.logicalName, identity);
    this.assertWritable(m.logicalName);
    const rows = (this.state.tables[m.logicalName] ??= []);
    const { input, nested, collectionBinds } = this.splitDeepInsert(m, data, identity);
    const row = { ...this.normalizeRecord(m, input, identity) };
    const blanks = blankTextColumns(this, m, row, options);
    if (options.coerce) this.coerceRecord(m, row, options);
    const pluginTarget = clone(row);
    for (const name of blanks) pluginTarget[name] = '';
    for (const [name, value] of Object.entries(options.derivedCreateColumns ?? {}))
      if (isDeepStrictEqual(pluginTarget[name], value)) delete pluginTarget[name];
    // Caller-owned audit and ownership columns (Dataverse layer); merged after coercion, only when passed.
    const systemColumns = this.systemColumnsFor(options.systemColumns, m, input);
    if (systemColumns) Object.assign(row, systemColumns);
    const suppliedPrimary = row[m.idColumn] != null,
      suppliedEmptyPrimary = !isElastic(m) && row[m.idColumn] === '00000000-0000-0000-0000-000000000000';
    if (
      options.sdkCreateId != null &&
      (typeof options.sdkCreateId !== 'string' || !GUID_PATTERN.test(options.sdkCreateId))
    )
      throw new DataError('Create requires a GUID Entity.Id.', 400, 'InvalidArgument', { innerCode: '0x80040203' });
    const seededId = options.sdkCreateId && options.sdkCreateId !== '00000000-0000-0000-0000-000000000000';
    if (seededId && suppliedPrimary && !suppliedEmptyPrimary && !equal(row[m.idColumn], options.sdkCreateId))
      throw new DataError('Entity Id must be the same as the value set in property bag', 400, 'InvalidArgument', {
        innerCode: '0x80040203',
      });
    for (const [key, value] of Object.entries(m.recordDefaults ?? {}))
      if (key !== 'statuscode' && !own(row, key)) {
        row[safeName(key)] = clone(value);
        if (fieldKind(this.fieldDefinition(m.logicalName, key, options.metadata)) === 'boolean')
          pluginTarget[key] = clone(value);
      }
    const changedAttributes = Object.keys(pluginTarget);
    if (!own(row, 'statuscode')) {
      const status = m.stateStatusDefaults?.[scalar(row.statecode)] ?? m.recordDefaults?.statuscode;
      if (status !== undefined) row.statuscode = clone(status);
    }
    if (options.coerce) this.assertStateStatus(m, row, options);
    // The portal writes as the site's application user: rows it creates carry that user as createdby
    // (observed.portalApplicationUser). Its id is not exported.
    const appUser = this.observed?.portalApplicationUser;
    if (appUser && !own(row, 'createdby'))
      row.createdby = { id: this.observed?.portalApplicationUserId ?? null, logical_name: 'systemuser', name: appUser };
    if (seededId) row[m.idColumn] = options.sdkCreateId;
    row[m.idColumn] ??= this.ids.uuid();
    // A caller's empty primary Attribute remains visible to PreValidation,
    // while the operation and Target Entity.Id already have an allocated GUID.
    if (suppliedEmptyPrimary && !seededId) row[m.idColumn] = this.ids.uuid();
    if (isElastic(m)) assertElasticRecord(row);
    const assertUniqueIdentity = () => {
      if (
        isElastic(m)
          ? rows.some((r) => equal(r[m.idColumn], row[m.idColumn]) && samePartition(r.partitionid, row.partitionid))
          : this.rowPositions(m, rows, row[m.idColumn], { scoped: true }).length > 0
      )
        throw new DataError('A record with matching key values already exists.', 412, 'DuplicateRecord', {
          innerCode: '0x80040237',
        });
    };
    assertUniqueIdentity();
    if (
      !identity.admin &&
      this.state.settings.permissionMode !== 'permissive' &&
      !this.rules(m.logicalName, 'create', identity).length
    )
      this.assertAllowed(m.logicalName, 'create', row, identity);
    row.createdon ??= isoUtc(this.clock.now());
    row.modifiedon ??= row.createdon;
    const derivedTargetColumns = new Set(
      [
        ...Object.keys(systemColumns ?? {}),
        ...Object.keys(options.derivedCreateColumns ?? {}),
        'createdon',
        'modifiedon',
      ].filter((name) => !own(pluginTarget, name)),
    );
    this.applyAutoNumbers(m, row, options);
    // The table-level Create gate above precedes all handlers. Row scope is
    // checked after trusted declarative effects establish any membership links.
    // Top-level stage10 SDK requests commit independently; stages20/40 and
    // nested stage10 requests participate in their caller transaction.
    // Preserve the request's original rollback boundary for portal row-scope denials.
    // SDK PreValidation writes otherwise advance that boundary independently.
    let deniedCreateBoundary;
    if (
      !identity.admin &&
      this.state.settings.permissionMode !== 'permissive' &&
      this.pluginPipeline &&
      this.pluginPipelineActive({ entity: m.logicalName, operation: 'create' }) &&
      this.pluginPipelineRequiresCheckpoint({
        entity: m.logicalName,
        operation: 'create',
        stage: 10,
        changedAttributes,
      })
    ) {
      this.promoteRowTransaction();
      this.ensureReadSnapshot();
      if (this.pluginRollbackBoundary) deniedCreateBoundary = { ...this.pluginRollbackBoundary };
    }
    const originalTarget = clone(pluginTarget);
    yield [m, 'create', 10, pluginTarget, row, null, identity, changedAttributes, options];
    options.afterPreValidation?.(m.logicalName, 'create', pluginTarget, null);
    // Showing authored inputs before platform stamps must not change their
    // established stored values when no observer edits that input column.
    for (const [name, value] of Object.entries(systemColumns ?? {}))
      if (
        own(originalTarget, name) &&
        !isDeepStrictEqual(originalTarget[name], value) &&
        isDeepStrictEqual(pluginTarget[name], originalTarget[name])
      ) {
        pluginTarget[name] = clone(value);
        row[name] = clone(value);
      }
    if (suppliedEmptyPrimary && pluginTarget[m.idColumn] === '00000000-0000-0000-0000-000000000000')
      throw new DataError('Expected non-empty Guid.', 400, 'InvalidArgument', { innerCode: '0x80040203' });
    // Dataverse allocates Entity.Id before PreValidation, then materializes the
    // generated primary-key Attribute for PreOperation and PostOperation.
    // Repeated native qualification: a pre10 Entity.Id change supplies the key
    // only when the caller did not supply a primary-key Attribute. Otherwise
    // the supplied Attribute restores Entity.Id at the stage20 transition.
    // An empty pre10 Id requests a fresh allocation, not the original GUID.
    const phaseFrame = this.pluginFrames?.get(row),
      phaseTarget = phaseFrame?.inputParameters?.values?.Target;
    if (!isElastic(m) && phaseTarget?.$type === 'Entity') {
      if (!suppliedPrimary) {
        if (!GUID_PATTERN.test(phaseTarget.id ?? ''))
          throw new DataError('Create requires a GUID target identity after PreValidation.', 400, 'LocalPluginInvalid');
        row[m.idColumn] = phaseTarget.id === '00000000-0000-0000-0000-000000000000' ? this.ids.uuid() : phaseTarget.id;
      }
      phaseTarget.id = row[m.idColumn];
    }
    pluginTarget[m.idColumn] ??= row[m.idColumn];
    for (const name of derivedTargetColumns)
      if (!own(pluginTarget, name) && own(row, name) && !notInTarget(name, row[name]))
        pluginTarget[name] = clone(row[name]);
    // Deep insert: single-valued navigation records are created first and bound.
    for (const item of nested.filter((entry) => entry.rel.many === false)) {
      const target = this.resolveMapping(item.rel.entity);
      if (Array.isArray(item.value))
        throw new DataError(`Single-valued navigation ${item.navigation} requires an object`, 400, 'InvalidLookup');
      const child = yield* this.createSteps(target.logicalName, item.value, identity, childOptions);
      row[item.rel.from] = {
        id: child[target.idColumn],
        logical_name: target.logicalName,
        name: primaryNameValue(target, child) ?? '',
      };
    }
    yield [m, 'create', 20, pluginTarget, row, null, identity, changedAttributes, options];
    options.mainOperation?.(m, 'create', row, null, pluginTarget, { identity, options });
    const effects = this.applyPlugins(m.logicalName, 'create', row, null, identity);
    assertAttachmentPolicy(this.state, m.logicalName, row);
    assertUniqueIdentity();
    this.assertAlternateKeys(m, row, rows, -1);
    options.authorizeEffectiveWrite?.(m.logicalName, 'create', row, null);
    this.insertRow(m.logicalName, rows, row);
    this.applySecondary(effects);
    try {
      this.assertAllowed(m.logicalName, 'create', row, identity);
    } catch (cause) {
      if (deniedCreateBoundary) Object.assign(this.pluginRollbackBoundary, deniedCreateBoundary);
      throw cause;
    }
    // Normalization drops raw navigation names; retain them for relationship validation.
    const bindingInput = this.pluginBindingInput(m, input, pluginTarget, identity);
    // Runtime audit/ownership stamps are not visitor-authored associations.
    // Keep explicit input and any plugin change subject to the normal checks.
    for (const [name, value] of Object.entries(systemColumns ?? {}))
      if (!own(input, name) && isDeepStrictEqual(bindingInput[name], value) && isDeepStrictEqual(row[name], value))
        delete bindingInput[name];
    this.validateBindings(m, bindingInput, row, identity, null, nativeContactAssociation);
    // Deep insert/bind into collection-valued navigation properties.
    for (const item of nested.filter((entry) => entry.rel.many !== false)) {
      const target = this.resolveMapping(item.rel.entity);
      for (const value of Array.isArray(item.value) ? item.value : [item.value]) {
        if (item.rel.intersect) {
          const child = yield* this.createSteps(target.logicalName, value, identity, childOptions);
          this.changeAssociationRecord(
            m.logicalName,
            row[m.idColumn],
            item.navigation,
            child[target.idColumn],
            identity,
            true,
            childOptions,
          );
        } else
          yield* this.createSteps(
            target.logicalName,
            {
              ...value,
              [item.rel.to]: {
                id: scalar(row[item.rel.from]),
                logical_name: m.logicalName,
                name: primaryNameValue(m, row) ?? '',
              },
            },
            identity,
            childOptions,
          );
      }
    }
    for (const bind of collectionBinds)
      for (const value of bind.refs) {
        const reference = parseEntityReference(value);
        if (!reference)
          throw new DataError(`Invalid lookup binding ${bind.navigation}@odata.bind`, 400, 'InvalidLookup');
        const target = this.resolveMapping(reference.set);
        if (target.logicalName !== this.resolveMapping(bind.rel.entity).logicalName)
          throw new DataError(
            `Lookup binding target does not match navigation ${bind.navigation}`,
            400,
            'InvalidLookup',
          );
        this.changeAssociationRecord(
          m.logicalName,
          row[m.idColumn],
          bind.navigation,
          reference.id,
          identity,
          true,
          options,
        );
      }
    // Native asynchronous Create snapshots include materialized defaults and
    // main-operation fields, as they stood before PostOperation ran (never the row version or empty on-behalf/team
    // lookups).
    for (const [name, value] of Object.entries(row))
      if (!notInTarget(name, value) && !(pluginTarget[name] === '' && value === null))
        pluginTarget[name] = clone(value);
    const asyncSourceParent = committedPluginParent(this, m, 'create', pluginTarget, row, options),
      asyncTarget = clone(pluginTarget),
      beforePost = prePostOperationFrame(this.pluginFrames?.get(row));
    // Values the main operation derived after PreOperation (exchangerate, <money>_base) belong to the Target the
    // asynchronous steps see (native crud: asynchronous Create Target carries them).
    const queuedTarget = beforePost.inputParameters?.values?.Target;
    if (queuedTarget?.$type === 'Entity') {
      const missing = Object.fromEntries(
        Object.entries(asyncTarget).filter(([name]) => !own(queuedTarget.attributes ?? {}, name)),
      );
      if (Object.keys(missing).length)
        Object.assign(
          (queuedTarget.attributes ??= {}),
          recordToSdkEntity(this, m.logicalName, missing, { allColumns: true, target: true }).attributes,
        );
    }
    if (isElastic(m)) {
      this.recordCommittedEvent(m.logicalName, 'create', row, changedAttributes, {
        target: pluginTarget,
        previous: null,
        identity,
        bypassCustomAsync: options.bypassCustomAsync === true,
        bypassStepIds: options.bypassStepIds,
        frame: { ...(this.pluginFrames?.get(row) ?? {}), asyncSourceParent },
      });
      this.checkpointElastic(m, row);
    }
    yield [m, 'create', 40, pluginTarget, row, null, identity, changedAttributes, options];
    if (!isElastic(m) && !options.deferCommittedEvent)
      this.recordCommittedEvent(m.logicalName, 'create', row, changedAttributes, {
        target: asyncTarget,
        previous: null,
        identity,
        bypassCustomAsync: options.bypassCustomAsync === true,
        bypassStepIds: options.bypassStepIds,
        frame: queuedFrame(this.pluginFrames?.get(row), beforePost, asyncSourceParent),
      });
    return row;
  }
  async create(entity, data, identity = {}, options = {}) {
    return this.transact(() => this.createRecordAsync(entity, data, identity, options), { incremental: true });
  }
  updateRecord(entity, id, data, identity = {}, options = {}) {
    return this.runRecordSteps(this.updateSteps(entity, id, data, identity, options));
  }
  /** updateRecord on the asynchronous pipeline: a promise of the updated row. */
  updateRecordAsync(entity, id, data, identity = {}, options = {}) {
    return this.awaitRecordSteps(this.updateSteps(entity, id, data, identity, options));
  }
  *updateSteps(entity, id, data, identity = {}, options = {}) {
    const inherited = this.pluginInTransaction;
    try {
      return yield* this.updateStepsCore(entity, id, data, identity, options);
    } finally {
      this.pluginInTransaction = inherited;
    }
  }
  *updateStepsCore(entity, id, data, identity = {}, options = {}) {
    const m = this.resolveMapping(entity);
    this.assertWritable(m.logicalName);
    const rows = (this.state.tables[m.logicalName] ??= []);
    const index = this.rowIndex(m, rows, id, { ...options, partitionId: options.partitionId ?? data.partitionid });
    if (index < 0) throw new DataError('Record not found', 404, 'NotFound');
    this.assertPrecondition(m, rows[index], options);
    this.assertAllowed(m.logicalName, 'update', rows[index], identity);
    const changes = this.normalizeRecord(m, data, identity);
    if (isElastic(m) && own(changes, 'partitionid') && !samePartition(changes.partitionid, rows[index].partitionid))
      throw new DataError('The partitionid value of an elastic table row cannot be changed.', 400, 'InvalidRequest');
    const blanks = blankTextColumns(this, m, changes, options);
    if (options.coerce) this.coerceRecord(m, changes, options);
    if (isElastic(m)) assertElasticRecord(changes);
    const input = {
      ...rows[index],
      ...changes,
      [m.idColumn]: rows[index][m.idColumn],
    };
    const row = this.touchRow(rows[index], input, this.systemColumnsFor(options.systemColumns, m, input));
    if (own(data, 'statecode') && !own(data, 'statuscode')) {
      const status = m.stateStatusDefaults?.[scalar(row.statecode)];
      if (status !== undefined) row.statuscode = clone(status);
    }
    if (options.coerce) this.assertStateStatus(m, row, options);
    this.assertAllowed(m.logicalName, 'update', row, identity);
    this.validateBindings(m, data, row, identity, rows[index]);
    for (const name of blanks) changes[name] = '';
    return yield* this.commitUpdateSteps(m, rows, index, row, identity, changes, options, data);
  }
  /** The systemColumns option: a plain object, or a function (mapping, row) => columns evaluated per row. */
  systemColumnsFor(option, mapping, row) {
    return typeof option === 'function' ? option(mapping, row) : option;
  }
  /**
   * Concurrency metadata that every Dataverse update sets: modifiedon is now and a
   * stored versionnumber advances, so earlier ETags stop matching (rows without a
   * stored version have a content-derived ETag, which changes with the row anyway).
   */
  touchRow(previous, row, systemColumns = null) {
    row.modifiedon = isoUtc(this.clock.now());
    if (systemColumns) Object.assign(row, systemColumns);
    // A caller that takes the row version itself (Dataverse's org-wide counter) keeps its value.
    if (systemColumns && 'versionnumber' in systemColumns) return row;
    if (isExactNumeric(previous.versionnumber)) {
      const version = sumNumeric([previous.versionnumber, 1], 'Int64');
      if (compareNumeric(version, '9223372036854775807') > 0)
        throw new DataError('Stored row version exceeds Int64.', 500, 'NumericVersionOverflow');
      row.versionnumber = version;
      return row;
    }
    const version = Number(scalar(previous.versionnumber));
    if (previous.versionnumber != null && Number.isSafeInteger(version)) row.versionnumber = version + 1;
    return row;
  }
  /** Commit an updated row: update plugins, unique alternate keys, secondary effects. */
  commitUpdate(mapping, rows, index, row, identity, target, options = {}, rawInput = {}) {
    return this.runRecordSteps(this.commitUpdateSteps(mapping, rows, index, row, identity, target, options, rawInput));
  }
  *commitUpdateSteps(mapping, rows, index, row, identity, target, options = {}, rawInput = {}) {
    const previous = clone(rows[index]);
    const authorizedWrite = target !== undefined;
    target ??= Object.fromEntries(
      Object.entries(row).filter(([key, value]) => !isDeepStrictEqual(value, previous[key])),
    );
    const changedAttributes = Object.keys(target);
    const stagedDefaults = Object.keys(row).filter(
      (key) => !own(target, key) && !isDeepStrictEqual(row[key], previous[key]),
    );
    // A named message's main-operation Update (plugin-platform-messages.mjs) has no PreValidation stage natively.
    if (!options.skipPreValidation)
      yield [mapping, 'update', 10, target, row, previous, identity, changedAttributes, options];
    options.afterPreValidation?.(mapping.logicalName, 'update', target, previous);
    for (const name of UPDATE_TARGET_STAMPS)
      if (authorizedWrite && !own(target, name) && own(row, name)) target[name] = clone(row[name]);
    yield [mapping, 'update', 20, target, row, previous, identity, changedAttributes, options];
    // A nested SDK request may patch or delete this row, or shift its position.
    // The outer update owns its current Target and staged system/default values;
    // untouched saved fields belong to the latest row, not the pre-plugin copy.
    index = this.rowIndex(mapping, rows, row[mapping.idColumn], {
      ...options,
      partitionId: row.partitionid ?? options.partitionId,
    });
    if (index < 0) throw new DataError('Record not found', 404, 'NotFound');
    const latest = rows[index];
    if (authorizedWrite) this.assertAllowed(mapping.logicalName, 'update', latest, identity);
    const merged = clone(latest);
    for (const key of new Set([...stagedDefaults, ...Object.keys(target)])) {
      if (own(row, key)) merged[key] = clone(row[key]);
      else delete merged[key];
    }
    for (const key of Object.keys(row)) delete row[key];
    Object.assign(row, merged);
    if (!isDeepStrictEqual(latest, previous))
      this.touchRow(latest, row, this.systemColumnsFor(options.systemColumns, mapping, row));
    if (authorizedWrite && this.pluginPipeline) {
      this.assertAllowed(mapping.logicalName, 'update', row, identity);
      this.validateBindings(
        mapping,
        this.pluginBindingInput(mapping, rawInput, target, identity),
        row,
        identity,
        latest,
      );
    }
    options.mainOperation?.(mapping, 'update', row, latest, target);
    const effects = this.applyPlugins(mapping.logicalName, 'update', row, rows[index], identity);
    // Declarative plugins mutate the row directly, independently of Target. Only changed columns reach the
    // attachment policy, so files already stored are not revalidated.
    const effectiveChanges = Object.fromEntries(
      Object.entries(row).filter(([key, value]) => !isDeepStrictEqual(value, previous[key])),
    );
    assertAttachmentPolicy(this.state, mapping.logicalName, row, { ...target, ...effectiveChanges });
    this.assertAlternateKeys(mapping, row, rows, index);
    options.authorizeEffectiveWrite?.(mapping.logicalName, 'update', row, latest);
    this.writeRow(mapping.logicalName, rows, index, row);
    this.applySecondary(effects);
    // Natively an Update that sets statecode runs the SetStateDynamicEntity pipeline inside its main operation, one
    // level deeper (recorded Web API PATCH statecode); the SetState message's own Update does not.
    if (options.stateMessage !== false && own(rawInput, 'statecode') && this.pluginPipeline)
      runStateMessage(this, mapping, row, identity, options);
    // The asynchronous copy adds platform modification stamps without changing
    // the synchronous partial Target or its qualified core-parent projection.
    const asyncTargetBaseline = Object.fromEntries(
      [mapping.idColumn, 'modifiedon', 'modifiedby', 'modifiedonbehalfby']
        .filter((name) => own(row, name))
        .map((name) => [name, clone(row[name])]),
    );
    const committedTarget = () => ({ ...asyncTargetBaseline, ...clone(target) });
    const asyncSourceParent = committedPluginParent(this, mapping, 'update', target, row, options),
      asyncTarget = committedTarget(),
      submitted = Object.keys(target),
      beforePost = prePostOperationFrame(this.pluginFrames?.get(row));
    if (isElastic(mapping)) {
      this.recordCommittedEvent(mapping.logicalName, 'update', row, Object.keys(target), {
        target: committedTarget(),
        previous,
        identity,
        bypassCustomAsync: options.bypassCustomAsync === true,
        bypassStepIds: options.bypassStepIds,
        frame: { ...(this.pluginFrames?.get(row) ?? {}), asyncSourceParent },
      });
      this.checkpointElastic(mapping, row);
    }
    yield [mapping, 'update', 40, target, row, previous, identity, changedAttributes, options];
    if (!isElastic(mapping) && !options.deferCommittedEvent)
      this.recordCommittedEvent(mapping.logicalName, 'update', row, submitted, {
        target: asyncTarget,
        previous,
        identity,
        bypassCustomAsync: options.bypassCustomAsync === true,
        bypassStepIds: options.bypassStepIds,
        frame: queuedFrame(this.pluginFrames?.get(row), beforePost, asyncSourceParent),
      });
    return row;
  }
  /**
   * A coerced write's status reason must belong to its status (Dataverse
   * InvalidStateCodeStatusCode, 0x80048408) when the statuscode metadata says which
   * statecode each status reason belongs to.
   */
  assertStateStatus(mapping, row, options = {}) {
    if (row.statuscode == null) return;
    const definition = this.fieldDefinition(mapping.logicalName, 'statuscode', options.metadata);
    const statuses = (definition?.statuses ?? definition?.options ?? []).filter((option) => option?.state != null);
    if (!statuses.length) return;
    const status = statuses.find((option) => Number(option.value) === Number(scalar(row.statuscode)));
    const state = scalar(row.statecode);
    if (!status || (state != null && Number(status.state) !== Number(state)))
      throw new DataError(
        'State code is invalid or state code is valid but status code is invalid for a specified state code.',
        400,
        'InvalidStateCodeStatusCode',
        { innerCode: '0x80048408' },
      );
  }
  async update(entity, id, data, identity = {}, options = {}) {
    return this.transact(() => this.updateRecordAsync(entity, id, data, identity, options), { incremental: true });
  }
  /**
   * PATCH semantics: update an existing record, or create it with the
   * supplied key. If-Match prevents creation; If-None-Match: * prevents update.
   */
  async upsert(entity, id, data, identity = {}, options = {}) {
    return this.transact(() => this.upsertRecordAsync(entity, id, data, identity, options), { incremental: true });
  }
  upsertRecord(entity, id, data, identity = {}, options = {}) {
    return this.runRecordSteps(this.upsertSteps(entity, id, data, identity, options));
  }
  /** upsertRecord on the asynchronous pipeline: a promise of { created, row }. */
  upsertRecordAsync(entity, id, data, identity = {}, options = {}) {
    return this.awaitRecordSteps(this.upsertSteps(entity, id, data, identity, options));
  }
  *upsertSteps(entity, id, data, identity = {}, options = {}) {
    const m = this.resolveMapping(entity);
    if (isElastic(m)) return yield* this.elasticUpsertSteps(entity, id, data, identity, options);
    const rows = this.state.tables[m.logicalName] ?? [];
    const existing =
      rows[this.rowIndex(m, rows, id, { ...options, partitionId: options.partitionId ?? data.partitionid })];
    this.assertPrecondition(m, existing ?? null, options);
    if (existing || options.ifMatch != null)
      return {
        created: false,
        row: yield* this.updateSteps(entity, id, data, identity, options),
      };
    return {
      created: true,
      row: yield* this.createSteps(entity, { ...data, [m.idColumn]: id }, identity, options),
    };
  }
  /** Elastic Upsert replaces the payload and raises Upsert, without dispatching Create or Update. */
  elasticUpsertRecord(entity, id, data, identity = {}, options = {}) {
    return this.runRecordSteps(this.elasticUpsertSteps(entity, id, data, identity, options));
  }
  /** elasticUpsertRecord on the asynchronous pipeline. */
  elasticUpsertRecordAsync(entity, id, data, identity = {}, options = {}) {
    return this.awaitRecordSteps(this.elasticUpsertSteps(entity, id, data, identity, options));
  }
  *elasticUpsertSteps(entity, id, data, identity = {}, options = {}) {
    const mapping = this.resolveMapping(entity);
    this.assertWritable(mapping.logicalName);
    const rows = (this.state.tables[mapping.logicalName] ??= []);
    const index = this.rowIndex(mapping, rows, id, {
      ...options,
      partitionId: options.partitionId ?? data.partitionid,
    });
    const previous = index < 0 ? null : rows[index];
    this.assertPrecondition(mapping, previous, options);
    this.assertAllowed(mapping.logicalName, previous ? 'update' : 'create', previous ?? data, identity);
    const row = this.normalizeRecord(mapping, data, identity);
    row[mapping.idColumn] = previous?.[mapping.idColumn] ?? parseKeySegment(id)?.[mapping.idColumn] ?? id;
    row.partitionid ??= previous?.partitionid ?? options.partitionId ?? null;
    if (previous && !samePartition(row.partitionid, previous.partitionid))
      throw new DataError('The partitionid value of an elastic table row cannot be changed.', 400, 'InvalidRequest');
    if (options.coerce) this.coerceRecord(mapping, row, options);
    assertElasticRecord(row);
    row.createdon = previous?.createdon ?? isoUtc(this.clock.now());
    row.modifiedon = isoUtc(this.clock.now());
    if (previous?.createdby) row.createdby = clone(previous.createdby);
    Object.assign(row, this.systemColumnsFor(options.systemColumns, mapping, row));
    const target = clone(row),
      attributes = Object.keys(data);
    yield [mapping, 'upsert', 10, target, row, previous, identity, attributes, options];
    yield [mapping, 'upsert', 20, target, row, previous, identity, attributes, options];
    this.validateBindings(mapping, data, row, identity, previous);
    this.assertAlternateKeys(mapping, row, rows, index);
    if (index < 0) this.insertRow(mapping.logicalName, rows, row);
    else this.writeRow(mapping.logicalName, rows, index, row);
    this.recordCommittedEvent(mapping.logicalName, previous ? 'update' : 'create', row, attributes, {
      target,
      previous,
      identity,
      bypassCustomAsync: options.bypassCustomAsync === true,
      bypassStepIds: options.bypassStepIds,
    });
    this.checkpointElastic(mapping, row);
    yield [mapping, 'upsert', 40, target, row, previous, identity, attributes, options];
    return { created: previous === null, row };
  }
  async remove(entity, id, identity = {}, options = {}) {
    return this.transact(() => this.removeRecordAsync(entity, id, identity, options), { incremental: true });
  }
  /** Synchronous only inside a caller-owned transaction, including backend SDK RPC. */
  removeRecord(entity, id, identity = {}, options = {}) {
    return this.runRecordSteps(this.removeSteps(entity, id, identity, options));
  }
  /** removeRecord on the asynchronous pipeline: a promise of the deleted row. */
  removeRecordAsync(entity, id, identity = {}, options = {}) {
    return this.awaitRecordSteps(this.removeSteps(entity, id, identity, options));
  }
  *removeSteps(entity, id, identity = {}, options = {}) {
    const inherited = this.pluginInTransaction;
    try {
      return yield* this.removeStepsCore(entity, id, identity, options);
    } finally {
      this.pluginInTransaction = inherited;
    }
  }
  *removeStepsCore(entity, id, identity = {}, options = {}) {
    const m = this.resolveMapping(entity);
    this.assertWritable(m.logicalName);
    const rows = (this.state.tables[m.logicalName] ??= []);
    const index = this.rowIndex(m, rows, id, options);
    if (index < 0) throw new DataError('Record not found', 404, 'NotFound');
    this.assertPrecondition(m, rows[index], options);
    this.assertAllowed(m.logicalName, 'delete', rows[index], identity);
    // Dataverse deletes hand the deleted rows (children first, root last) to the recycle bin; portal deletes never collect them.
    if (identity?.dataverse && this.recycleDeleted) {
      const deleted = [];
      const result = yield* this.deleteRowSteps(m, rows[index], identity, new Set(), { ...options, deleted });
      this.recycleDeleted(deleted, identity);
      return result;
    }
    return yield* this.deleteRowSteps(m, rows[index], identity, new Set(), options);
  }
  /**
   * Delete a row with the delete behaviour of every one-to-many relationship that
   * references it (relationship.cascade.delete, the Solution's CascadeDelete):
   * "Cascade" deletes the referencing rows, whose own relationships apply in turn;
   * "RemoveLink" clears their lookup through the update pipeline; "Restrict" refuses
   * the delete while one exists (CannotDeleteDueToAssociation, 0x80040227, 405 as the
   * Dataverse Web API documents it); "NoCascade" leaves them. A relationship without
   * imported configuration uses RemoveLink, Dataverse's default for a referential
   * relationship, and is recorded in cascadeDiagnostics(). Intersect rows of
   * many-to-many relationships go with the row. Cascaded changes are the platform's
   * own, so table permissions aren't checked for them; delete and update plugins run.
   */
  deleteRow(mapping, row, identity, deleting, options = {}) {
    return this.runRecordSteps(this.deleteRowSteps(mapping, row, identity, deleting, options));
  }
  *deleteRowSteps(mapping, row, identity, deleting, options = {}) {
    const key = `${mapping.logicalName}\u0000${recordKey(mapping, row)}`;
    if (deleting.has(key)) return row;
    for (const guard of this.deleteGuards ?? []) {
      const result = guard({ entity: mapping.logicalName, row: clone(row), identity: clone(identity) });
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new DataError('Delete guards cannot return a promise.', 500, 'InvalidDeleteGuard');
      }
    }
    deleting.add(key);
    const target = { [mapping.idColumn]: row[mapping.idColumn] },
      attributes = Object.keys(target);
    yield [mapping, 'delete', 10, target, row, row, identity, attributes, options];
    yield [mapping, 'delete', 20, target, row, row, identity, attributes, options];
    // A nested SDK write can replace the saved root during PreValidation or
    // PreOperation. Authorize that current row before any cascade or main
    // effect, without replacing the captured row used by this message's images.
    if (options.authorizeEffectiveWrite?.preflight) {
      const currentRows = this.state.tables[mapping.logicalName] ?? [];
      const currentIndex = this.rowIndex(mapping, currentRows, recordKey(mapping, row));
      if (currentIndex < 0) throw new DataError('Record not found', 404, 'NotFound');
      options.authorizeEffectiveWrite.preflight(mapping.logicalName, 'delete', currentRows[currentIndex], null);
    }
    const effects = this.applyPlugins(mapping.logicalName, 'delete', clone(row), row, identity);
    for (const reference of this.referencesTo(mapping.logicalName, identity, deleting)) {
      const target = scalar(field(row, reference.targetColumn ?? mapping.idColumn));
      if (target == null) continue;
      const children = (this.state.tables[reference.entity] ?? []).filter((child) => {
        const value = field(child, reference.column);
        if (value && typeof value === 'object' && value.logical_name && value.logical_name !== mapping.logicalName)
          return false;
        return equal(scalar(value), target);
      });
      if (!children.length) continue;
      const behaviour = reference.cascade?.delete ?? 'RemoveLink';
      if (reference.cascade?.delete == null) this.noteCascadeDefault(mapping.logicalName, reference);
      if (behaviour === 'Restrict')
        throw new DataError(
          'The object you tried to delete is associated with another object and cannot be deleted.',
          405,
          'CannotDeleteDueToAssociation',
          { innerCode: '0x80040227', table: reference.entity, relationship: reference.schemaName ?? null },
        );
      if (behaviour !== 'Cascade' && behaviour !== 'RemoveLink') continue;
      const childMapping = this.resolveMapping(reference.entity);
      for (const child of children) {
        const rows = this.state.tables[reference.entity];
        const index = this.rowPositions(childMapping, rows, child[childMapping.idColumn])[0] ?? -1;
        if (index < 0) continue;
        if (behaviour === 'Cascade')
          yield* this.deleteRowSteps(childMapping, rows[index], identity, deleting, {
            systemColumns: options.systemColumns,
            deleted: options.deleted,
          });
        else {
          const input = { ...rows[index], [reference.column]: null };
          const next = this.touchRow(
            rows[index],
            input,
            this.systemColumnsFor(options.systemColumns, childMapping, input),
          );
          yield* this.commitUpdateSteps(childMapping, rows, index, next, identity);
        }
      }
    }
    const graph = this.relationshipGraph(deleting);
    graph.intersects ??= Object.entries(this.state.mappings ?? {}).flatMap(([owner, ownerMapping]) =>
      Object.values(this.relationshipsFor(ownerMapping ?? {}, identity))
        .filter((rel) => rel?.intersect?.entity)
        .map((rel) => [owner, rel]),
    );
    for (const [owner, rel] of graph.intersects) {
      if (!this.state.tables[rel.intersect.entity]?.length) continue;
      const sides = [];
      if (owner === mapping.logicalName) sides.push([rel.intersect.from, scalar(field(row, rel.from))]);
      if (rel.entity === mapping.logicalName) sides.push([rel.intersect.to, scalar(field(row, rel.to))]);
      for (const [column, value] of sides)
        if (value != null) {
          const edges = this.state.tables[rel.intersect.entity];
          for (let index = edges.length - 1; index >= 0; index--)
            if (equal(scalar(field(edges[index], column)), value)) this.removeRow(rel.intersect.entity, edges, index);
        }
    }
    const rows = this.state.tables[mapping.logicalName] ?? [];
    const index = this.rowIndex(mapping, rows, recordKey(mapping, row));
    if (options.authorizeEffectiveWrite && index < 0) throw new DataError('Record not found', 404, 'NotFound');
    if (index >= 0) {
      options.authorizeEffectiveWrite?.(mapping.logicalName, 'delete', rows[index], null);
      this.removeRow(mapping.logicalName, rows, index);
      options.deleted?.push({ logicalName: mapping.logicalName, row: clone(row) });
    }
    this.applySecondary(effects);
    if (isElastic(mapping)) {
      this.recordCommittedEvent(mapping.logicalName, 'delete', row, attributes, {
        target,
        previous: row,
        identity,
        bypassCustomAsync: options.bypassCustomAsync === true,
        bypassStepIds: options.bypassStepIds,
      });
      this.checkpointElastic(mapping, row, true);
    }
    yield [mapping, 'delete', 40, target, row, row, identity, attributes, options];
    if (!isElastic(mapping))
      this.recordCommittedEvent(mapping.logicalName, 'delete', row, attributes, {
        target,
        previous: row,
        identity,
        bypassCustomAsync: options.bypassCustomAsync === true,
        bypassStepIds: options.bypassStepIds,
      });
    return row;
  }
  /**
   * One-to-many relationships whose lookup references `logical`, from either side's
   * mapping (the child's single-valued lookup or the parent's collection), once per
   * referencing table and lookup column: { entity, column, targetColumn, cascade, schemaName }.
   */
  referencesTo(logical, identity = {}, scope) {
    const graph = scope ? this.relationshipGraph(scope) : null;
    if (graph?.references.has(logical)) return graph.references.get(logical);
    const references = this.referencesByTable(identity, logical).get(logical) ?? [];
    graph?.references.set(logical, references);
    return references;
  }
  /** referencesTo of every table (or of `only`) from one pass over the relationships: Map logical -> references. */
  referencesByTable(identity = {}, only) {
    const tables = new Map();
    for (const [owner, ownerMapping] of Object.entries(this.state.mappings ?? {}))
      for (const rel of Object.values(this.relationshipsFor(ownerMapping ?? {}, identity))) {
        if (!rel || rel.intersect || !rel.entity || !rel.from || !rel.to) continue;
        // A single-valued lookup references its target; a collection references its owner.
        const single = rel.many === false,
          logical = single ? rel.entity : owner;
        if (only !== undefined && logical !== only) continue;
        const reference = single
          ? { entity: owner, column: rel.from, targetColumn: rel.to, cascade: rel.cascade, schemaName: rel.schemaName }
          : {
              entity: rel.entity,
              column: rel.to,
              targetColumn: rel.from,
              cascade: rel.cascade,
              schemaName: rel.schemaName,
            };
        let found = tables.get(logical);
        if (!found) tables.set(logical, (found = new Map()));
        const key = `${reference.entity}\u0000${reference.column}`;
        const existing = found.get(key);
        if (!existing || (!existing.cascade && reference.cascade)) found.set(key, reference);
      }
    return new Map([...tables].map(([logical, found]) => [logical, [...found.values()]]));
  }
  /**
   * The relationship graph one delete operation walks: referencesTo per table and the
   * many-to-many intersect list, memoised for the operation's `scope` (its cascade's
   * `deleting` set), so a cascade tree walks the mappings once per table, not per row.
   * ponytail: scoped to one operation because mappings have no revision counter; a
   * store-wide cache needs one bumped by every metadata writer.
   */
  relationshipGraph(scope) {
    this.relationshipGraphs ??= new WeakMap();
    let graph = this.relationshipGraphs.get(scope);
    if (!graph) this.relationshipGraphs.set(scope, (graph = { references: new Map(), intersects: null }));
    return graph;
  }
  noteCascadeDefault(logical, reference) {
    this.defaultedCascades ??= new Map();
    const key = `${reference.entity}\u0000${reference.column}\u0000${logical}`;
    if (!this.defaultedCascades.has(key))
      this.defaultedCascades.set(key, {
        code: 'CASCADE_DELETE_DEFAULTED',
        table: logical,
        referencing: reference.entity,
        column: reference.column,
        relationship: reference.schemaName ?? null,
        message: `No imported CascadeDelete for ${reference.entity}.${reference.column} -> ${logical}; RemoveLink, the Dataverse default for a referential relationship, was applied.`,
      });
  }
  /** Relationships whose delete behaviour defaulted to RemoveLink (no imported cascade). */
  cascadeDiagnostics() {
    return [...(this.defaultedCascades?.values() ?? [])];
  }
  async associate(entity, id, navigation, targetId, identity = {}, options = {}) {
    return this.changeAssociation(entity, id, navigation, targetId, identity, true, options);
  }
  async disassociate(entity, id, navigation, targetId, identity = {}, options = {}) {
    return this.changeAssociation(entity, id, navigation, targetId, identity, false, options);
  }
  async changeAssociation(entity, id, navigation, targetId, identity, associate, options = {}) {
    return this.transact(
      () => this.changeAssociationRecordAsync(entity, id, navigation, targetId, identity, associate, options),
      { incremental: true },
    );
  }
  changeAssociationRecord(entity, id, navigation, targetId, identity, associate, options = {}) {
    return this.runRecordSteps(
      this.changeAssociationSteps(entity, id, navigation, targetId, identity, associate, options),
    );
  }
  /** changeAssociationRecord on the asynchronous pipeline (awaitRecordSteps): the referencing row's update steps await a
   * synchronous service endpoint step's post (a flow Relate/Unrelate rows action, the Web API $ref). */
  changeAssociationRecordAsync(entity, id, navigation, targetId, identity, associate, options = {}) {
    return this.awaitRecordSteps(
      this.changeAssociationSteps(entity, id, navigation, targetId, identity, associate, options),
    );
  }
  *changeAssociationSteps(entity, id, navigation, targetId, identity, associate, options = {}) {
    const mapping = this.resolveMapping(entity);
    const relationship = this.relationshipsFor(mapping, identity)[safeName(navigation)];
    if (!relationship) throw new DataError('Association navigation has no mapping', 400, 'MissingRelationship');
    if (relationship.intersect) this.assertWritable(this.resolveMapping(relationship.intersect.entity).logicalName);
    if (relationship.many === false)
      throw new DataError('Use a lookup binding for a single-valued navigation', 400, 'InvalidAssociation');
    const row = (this.state.tables[mapping.logicalName] ?? []).find((record) => equal(record[mapping.idColumn], id));
    if (!row) throw new DataError('Association source record not found', 404, 'NotFound');
    this.assertAllowed(mapping.logicalName, 'update', row, identity);
    const targetMapping = this.resolveMapping(relationship.entity);
    const target = (this.state.tables[targetMapping.logicalName] ?? []).find((record) =>
      equal(record[targetMapping.idColumn], targetId),
    );
    if (!target) throw new DataError('Association target record not found', 404, 'NotFound');
    const edgeMapping = relationship.intersect ? this.resolveMapping(relationship.intersect.entity) : null;
    // A Solution N:N declaration marks its implicit intersect table even when
    // that table has no Entity.xml. Portal association rights belong to the
    // endpoints; direct CRUD and project-configured edge tables keep their own
    // permissions. Do not infer this contract from an arbitrary collection map.
    const nativeIntersect =
      edgeMapping?.intersect === true &&
      edgeMapping.userConfigured !== true &&
      relationship.type === 'many-to-many' &&
      Boolean(relationship.schemaName);
    if (nativeIntersect) {
      try {
        this.assertAllowed(mapping.logicalName, 'append', row, identity, targetMapping.logicalName);
        this.assertAllowed(targetMapping.logicalName, 'appendTo', target, identity, mapping.logicalName);
      } catch (error) {
        if (
          options.portalRequest === true &&
          mapping.logicalName === targetMapping.logicalName &&
          error?.code === 'PermissionDenied'
        )
          error.details = {
            ...error.details,
            portalSelfNnAssociation: { schema: relationship.schemaName, table: mapping.logicalName },
          };
        throw error;
      }
    } else this.assertBindingTarget(mapping, row, targetMapping, target, identity);
    if (relationship.intersect) {
      const link = relationship.intersect;
      const edges = (this.state.tables[edgeMapping.logicalName] ??= []);
      const values = {
        [link.from]: scalar(field(row, relationship.from)),
        [link.to]: scalar(field(target, relationship.to)),
      };
      const existing = edges.filter((edge) =>
        Object.entries(values).every(([key, value]) => equal(field(edge, key), value)),
      );
      if (associate) {
        const edge = { [edgeMapping.idColumn]: this.ids.uuid(), ...values };
        if (!nativeIntersect) this.assertAllowed(edgeMapping.logicalName, 'create', edge, identity);
        if (!existing.length) this.insertRow(edgeMapping.logicalName, edges, edge);
      } else {
        if (!nativeIntersect && !existing.length)
          this.assertAllowed(edgeMapping.logicalName, 'delete', values, identity);
        for (const edge of nativeIntersect ? [] : existing)
          this.assertAllowed(edgeMapping.logicalName, 'delete', edge, identity);
        const removed = new Set(existing);
        for (let index = edges.length - 1; index >= 0; index--)
          if (removed.has(edges[index])) this.removeRow(edgeMapping.logicalName, edges, index);
      }
    } else {
      if (relationship.to === targetMapping.idColumn)
        throw new DataError('Collection mapping cannot reassign a target primary key', 400, 'InvalidAssociation');
      this.assertAllowed(targetMapping.logicalName, 'update', target, identity);
      const value = associate
        ? clone(row[relationship.from])
        : this.relationshipMatches(row, target, relationship)
          ? null
          : undefined;
      if (value !== undefined) {
        // A one-to-many association sets or clears the referencing row's lookup: an
        // update of that row through the update pipeline (version, modifiedon, plugins).
        const rows = this.state.tables[targetMapping.logicalName];
        const input = { ...target, [relationship.to]: value };
        const next = this.touchRow(target, input, this.systemColumnsFor(options.systemColumns, targetMapping, input));
        this.assertAllowed(targetMapping.logicalName, 'update', next, identity);
        // This Update belongs to the association's execution policy. Parent
        // response tokens and one-use authorization capabilities belong to the
        // outer operation, so forward only its plug-in bypass controls.
        yield* this.commitUpdateSteps(targetMapping, rows, rows.indexOf(target), next, identity, undefined, {
          bypassCustomPlugins: options.bypassCustomPlugins === true,
          bypassCustomAsync: options.bypassCustomAsync === true,
          bypassStepIds: options.bypassStepIds,
        });
      }
    }
    return {
      associated: associate,
      entity: mapping.logicalName,
      recordId: id,
      navigation,
      targetId,
    };
  }
  async applyPreset(name, { generatedPresets = this.presetLibrary, returnSnapshot = true } = {}) {
    const preset = resolvePreset(this.state, name, generatedPresets, this.recordContext());
    if (!preset) throw new DataError(`Unknown preset ${name}`, 404);
    if (preset.personaCatalog !== undefined) validatePersonaCatalog(preset.personaCatalog, `Preset ${name}`);
    return this.transact(
      () => {
        applyPresetSections(this.state, preset, { owned: true });
        this.state = normalizeState(this.state, this.presetLibrary, this.platformConfig, true);
        return returnSnapshot ? this.state : undefined;
      },
      { cloneResult: returnSnapshot },
    );
  }
  /**
   * Evaluate FetchXML for an identity. options.profile "webapi" applies the
   * Dataverse schema strictly (public /_api?fetchXml=); the default "portal"
   * profile models Liquid/list/lookup execution through the portal.
   */
  liquidFetchPermissionOptions(options = {}) {
    if (this.observed?.liquidFetchRights !== 'native-classic' || options.profile === 'webapi') return {};
    const right = String(options.right ?? 'read').toLowerCase();
    const operation =
      right === 'write'
        ? 'update'
        : right === 'create'
          ? 'create'
          : right === 'delete'
            ? 'delete'
            : right === 'append'
              ? 'append'
              : right === 'appendto'
                ? 'appendTo'
                : 'read';
    return { operation, unscopedCreate: operation === 'create' };
  }
  previewPermissionFetchXml(xml, identity = {}, options = {}) {
    const authoredXml = xml,
      native = !identity.admin && this.observed?.tablePermissionQueryPipeline === 'native-classic';
    if (!identity.admin)
      xml = preparePortalFetchXml(xml, { linkTypes: this.observed?.liquidFetchXmlLinkTypes, profile: 'liquid' });
    const preview = compilePermissionFetchXml(xml, {
      permissions: this.state.permissions,
      identity,
      mappings: this.state.mappings,
      rules: this.rules.bind(this),
      bypass: this.state.settings.permissionMode === 'permissive',
      grantOrder: this.observed?.tablePermissionGrantOrder,
      forceScopedDistinct: native,
      seedAliasesFromAuthoredLinks: native,
      ...this.liquidFetchPermissionOptions(options),
    });
    preview.authoredXml = authoredXml;
    return preview;
  }
  fetchXml(xml, identity = {}, options = {}) {
    if (!this.hasOperationContext()) return this.withOperationContext(() => this.fetchXml(xml, identity, options));
    // Column security of the reading principal on every returned row, link-entity and aliased column included
    // (portal-authorization.mjs maskRow), as get() and query().
    // A condition, order, aggregate or distinct over a column it reads masked is refused first (assertOperands, 0x80041155).
    if (this.portalAuthorization && !options.portalMasked) {
      const root = parseFetchXml(xml).children.find((node) => node.name === 'entity')?.attrs.name;
      if (root)
        this.portalAuthorization.assertOperands(identity, root, {
          portalRequest: options.portalRequest === true,
          fetchXml: xml,
        });
      const result = this.fetchXml(xml, identity, { ...options, portalMasked: true }),
        info = result?.columns;
      const logical = info?.root ?? root;
      if (Array.isArray(result?.entities) && logical)
        result.entities = result.entities.map((row) =>
          this.portalAuthorization.maskRow(identity, logical, row, {
            portalRequest: options.portalRequest === true,
            fetch: info ?? null,
          }),
        );
      return result;
    }
    const authoredXml = xml;
    if (options.portalRequest === true && !identity.admin)
      xml = preparePortalFetchXml(xml, {
        linkTypes:
          options.profile === 'webapi'
            ? this.observed?.webApiFetchXmlLinkTypes
            : this.observed?.liquidFetchXmlLinkTypes,
        profile: options.profile === 'webapi' ? 'webapi' : 'liquid',
      });
    const authoredFetch = parseFetchXml(xml);
    const entity = authoredFetch.children.find((node) => node.name === 'entity')?.attrs.name;
    // Observers may mutate data inside a read transaction before its revision advances.
    // Keep every plugin invocation and discard cached row inputs at that boundary.
    if (
      options.fetchCache &&
      this.pluginPipeline &&
      this.pluginPipelineActive({
        entity,
        operation: 'retrievemultiple',
        bypassCustomPlugins: options.bypassCustomPlugins === true,
        bypassStepIds: options.bypassStepIds,
      })
    ) {
      options.fetchCache.invalidate(this);
      options = { ...options, fetchCache: undefined };
    }
    const nativeAdmission =
      options.portalRequest === true &&
      !identity.admin &&
      this.observed?.tablePermissionQueryPipeline === 'native-classic';
    let linkedPermissionOrdinals = [];
    if (nativeAdmission && options.profile === 'webapi') {
      // The native API checks authored tables and the expanded execution budget
      // before admitting RetrieveMultiple. Liquid admits its expanded query and
      // encounters backend budgets after PreOperation instead.
      let authored;
      try {
        authored = planFetch(parseFetchXml(xml), {
          profile: 'webapi',
          limits: this.querySettings().fetchLimits,
          linkBudgetError: this.observed?.fetchLinkBudgetError,
        });
      } catch (cause) {
        if (cause.details?.innerCode === '0x8004430d')
          throw new DataError(
            'An unexpected error occurred while processing the request',
            500,
            'PortalQueryAdmissionFailure',
            { phase: 'native-api-admission' },
          );
        throw cause;
      }
      const mappingOf = new Map(
        [authored.root, ...authored.links].map((node) => [node, this.resolveMapping(node.attrs.name)]),
      );
      const intersects = structuralIntersects(authored, mappingOf);
      linkedPermissionOrdinals = authored.links.flatMap((link, index) => (intersects.has(link) ? [] : [index]));
      const names = new Set([
        authored.root.attrs.name,
        ...linkedPermissionOrdinals.map((index) => authored.links[index].attrs.name),
      ]);
      if (this.state.settings.permissionMode !== 'permissive')
        for (const name of names)
          if (!this.rules(name, 'read', identity).length)
            throw new DataError('Table permission denies read on ' + name, 403, 'PermissionDenied', {
              operation: 'read',
              table: name,
            });
    }
    // Scoped portal paths default to unique projected tuples in both lanes.
    // Global Web API reads retain authored multiplicity; the qualified native
    // profile additionally forces scoped DISTINCT when explicitly disabled.
    const permissionQuery = compilePermissionFetchXml(xml, {
      permissions: this.state.permissions,
      identity,
      mappings: this.state.mappings,
      rules: this.rules.bind(this),
      bypass: this.state.settings.permissionMode === 'permissive',
      linkedPermissionOrdinals,
      grantOrder: this.observed?.tablePermissionGrantOrder,
      defaultDistinct: true,
      defaultGlobalDistinct: options.profile !== 'webapi',
      forceScopedDistinct: nativeAdmission,
      seedAliasesFromAuthoredLinks: nativeAdmission,
      ...(options.portalRequest === true ? this.liquidFetchPermissionOptions(options) : {}),
    });
    permissionQuery.authoredXml = authoredXml;
    let result;
    try {
      result = this.executePermissionFetchXml(xml, identity, options, permissionQuery);
    } catch (cause) {
      if (
        options.portalRequest &&
        permissionQuery.permissionLinkCount > 0 &&
        cause.details?.innerCode === '0x8004430d'
      ) {
        const limit = cause.details.limit ?? this.querySettings().fetchLimits.links;
        const diagnostic = {
          code: 'PERMISSION_LINK_BUDGET_EXCEEDED',
          severity: 'warning',
          table: entity,
          authoredLinks: permissionQuery.authoredLinkCount,
          generatedLinks: permissionQuery.permissionLinkCount,
          totalLinks: permissionQuery.totalLinkCount,
          limit,
          ordinaryLinks: cause.details.ordinaryLinks,
          filterLinks: cause.details.filterLinks,
          grantPaths: permissionQuery.grantPaths,
          message: `Table permissions expanded ${permissionQuery.authoredLinkCount} authored links to ${permissionQuery.totalLinkCount} total links; the applicable join/filter budget is ${limit}.`,
        };
        cause.details = { ...cause.details, permissionDiagnostic: diagnostic };
        options.diagnostic?.(diagnostic);
      }
      throw cause;
    }
    if (
      options.portalRequest &&
      ['false', '0'].includes(parseFetchXml(permissionQuery.xml).attrs.distinct?.toLowerCase()) &&
      permissionQuery.multiplicativePaths.length &&
      !result.columns?.aggregate
    ) {
      const mapping = this.resolveMapping(entity);
      const returnedRows = result.entities.length,
        uniqueRootRows = new Set(result.entities.map((row) => row[mapping.idColumn])).size;
      const diagnostic = {
        code: 'PERMISSION_QUERY_ROW_MULTIPLICATION',
        severity: 'info',
        table: entity,
        returnedRows,
        uniqueRootRows,
        additionalRows: returnedRows - uniqueRootRows,
        generatedLinks: permissionQuery.permissionLinkCount,
        grantPaths: permissionQuery.multiplicativePaths,
        message: `Permission joins with distinct=false returned ${returnedRows} rows for ${uniqueRootRows} unique ${entity} roots.`,
      };
      permissionQuery.diagnostics.push(diagnostic);
      options.diagnostic?.(diagnostic);
    }
    return options.portalRequest === true && options.profile !== 'webapi'
      ? Object.assign(result, {
          permission_granted: permissionQuery.permissionGranted,
          global_permission_granted: permissionQuery.globalPermissionGranted,
          rules_exist: true,
        })
      : result;
  }
  executePermissionFetchXml(xml, identity, options, permissionQuery) {
    const entity = parseFetchXml(xml).children.find((node) => node.name === 'entity')?.attrs.name;
    const nativeAdmission =
      options.portalRequest === true &&
      !identity.admin &&
      this.observed?.tablePermissionQueryPipeline === 'native-classic';
    const executionOptions = { ...options, permissionQuery };
    if (nativeAdmission && options.profile === 'webapi' && permissionQuery.transport !== 'source-derived-scalar-odata')
      assertPortalFetchXmlTransport(permissionQuery.xml, this.observed?.webApiFetchXmlTransport);
    if (nativeAdmission && options.profile === 'webapi' && permissionQuery.transport !== 'source-derived-scalar-odata')
      planFetch(parseFetchXml(permissionQuery.xml), {
        profile: 'webapi',
        limits: this.querySettings().fetchLimits,
        linkBudgetError: this.observed?.fetchLinkBudgetError,
      });
    if (nativeAdmission && options.profile !== 'webapi' && !permissionQuery.permissionGranted) {
      // A denied Liquid root returns its normalized authored XML and an empty
      // result, without a Dataverse invocation or a generated DISTINCT default.
      executionOptions.noBackendAdmission = true;
      return Object.assign(this.fetchXmlCore(permissionQuery.xml, identity, executionOptions), {
        entities: [],
        more_records: false,
        paging_cookie: null,
        total_record_count: 0,
        total_record_count_limit_exceeded: false,
        xml: permissionQuery.xml,
        permissionQuery: {
          qualification: permissionQuery.qualification,
          authoredLinkCount: permissionQuery.authoredLinkCount,
          permissionLinkCount: 0,
          totalLinkCount: permissionQuery.authoredLinkCount,
          diagnostics: permissionQuery.diagnostics,
        },
        backendAdmission: 'denied-before-dataverse',
      });
    }
    // Generated-link privileges belong to the compiler's exact structural tree.
    // Never reuse traversal ordinals after an observer inserts, replaces or
    // rearranges authored links. Query value filters at the root can still vary.
    const execute = (source) => {
      const rebound = rebindPermissionQuery(permissionQuery, source);
      const result = executeSdkFetch(this, source, (prepared) =>
        this.fetchXmlCore(prepared, identity, { ...executionOptions, permissionQuery: rebound }),
      );
      return Object.assign(result, {
        xml: nativeAdmission && options.profile !== 'webapi' ? permissionQuery.xml : source,
        executedXml: source,
        permissionQuery: {
          qualification: permissionQuery.qualification,
          authoredLinkCount: permissionQuery.authoredLinkCount,
          permissionLinkCount: permissionQuery.permissionLinkCount,
          totalLinkCount: permissionQuery.totalLinkCount,
          diagnostics: permissionQuery.diagnostics,
        },
      });
    };
    if (
      options.skipPluginRead ||
      !entity ||
      !this.pluginPipeline ||
      !this.pluginPipelineActive({
        entity,
        operation: 'retrievemultiple',
        bypassCustomPlugins: options.bypassCustomPlugins === true,
        bypassStepIds: options.bypassStepIds,
      })
    )
      return options.sdkResult
        ? execute(permissionQuery.xml)
        : Object.assign(this.fetchXmlCore(permissionQuery.xml, identity, executionOptions), {
            xml: permissionQuery.xml,
            permissionQuery: {
              qualification: permissionQuery.qualification,
              authoredLinkCount: permissionQuery.authoredLinkCount,
              permissionLinkCount: permissionQuery.permissionLinkCount,
              totalLinkCount: permissionQuery.totalLinkCount,
              diagnostics: permissionQuery.diagnostics,
            },
          });
    return this.retrieveMultipleOperation(
      entity,
      identity.admin && options.sdkQuery ? options.sdkQuery : { $type: 'FetchExpression', query: permissionQuery.xml },
      identity,
      (query) => {
        if (identity.admin && options.sdkQuery && sameSdkQuery(query, options.sdkQuery))
          return execute(permissionQuery.xml);
        const source = ['QueryExpression', 'QueryByAttribute'].includes(query.$type)
          ? queryExpressionToFetch(
              query.$type === 'QueryByAttribute'
                ? {
                    ...query,
                    $type: 'QueryExpression',
                    linkEntities: [],
                    criteria: {
                      operatorName: 'And',
                      filters: [],
                      conditions: (query.attributes ?? []).map((attributeName, index) => ({
                        attributeName,
                        operatorName: 'Equal',
                        values: [query.values?.[index]],
                      })),
                    },
                  }
                : query,
              this,
            )
          : query.$type === 'FetchExpression'
            ? query.query
            : null;
        if (!source || parseFetchXml(source).children.find((node) => node.name === 'entity')?.attrs.name !== entity)
          throw new DataError(
            'A RetrieveMultiple observer cannot change the bound query table or type.',
            501,
            'LocalPluginQueryUnsupported',
          );
        return execute(source);
      },
      'entities',
      options.sdkResponseToken,
      { ...options, queryTransport: permissionQuery.transport },
    );
  }
  fetchXmlCore(xml, identity = {}, options = {}) {
    const tableLimits = this.querySettings().fetchLimits;
    const planOptions = {
      profile:
        options.sdkResult === true && options.portalRequest !== true
          ? 'sdk'
          : options.profile === 'webapi'
            ? 'webapi'
            : 'portal',
      limits: options.noBackendAdmission
        ? {
            ...tableLimits,
            links: Number.MAX_SAFE_INTEGER,
            linksAndFilters: Number.MAX_SAFE_INTEGER,
            conditionsAndLinks: Number.MAX_SAFE_INTEGER,
            linkDepth: Number.MAX_SAFE_INTEGER,
          }
        : tableLimits,
      generatedAnyAllAliases: options.permissionQuery?.generatedAnyAllAliases ?? [],
      linkBudgetError: this.observed?.fetchLinkBudgetError,
      ...(identity?.dataverse ? { dataverseIdentity: true } : {}),
    };
    const buildPlan = () => planFetch(parseFetchXml(xml), planOptions);
    const validated = options.fetchCache
      ? options.fetchCache.plan(JSON.stringify([xml, planOptions]), buildPlan)
      : buildPlan();
    // Syntax and admission errors precede table lookup, including an unmapped root. Specialize the validated
    // plan without mutating the render cache; the count attribute has already passed integer validation.
    const elastic = isElastic(this.resolveMapping(validated.root.attrs.name));
    const count = Number(validated.fetch.attrs.count);
    const plan = elastic
      ? {
          ...validated,
          limits: { ...validated.limits, pageSize: 500, totalRecordCount: 500 },
          pageSize: count ? Math.min(count, 500) : 500,
          totalRecordCountLimit: 500,
        }
      : validated;
    // Native Liquid keeps an omitted returntotalrecordcount omitted in its
    // exposed query and returns -1; no count is injected.
    if (
      options.portalRequest === true &&
      options.profile !== 'webapi' &&
      options.permissionQuery &&
      this.observed?.tablePermissionQueryPipeline === 'native-classic' &&
      plan.fetch.attrs.returntotalrecordcount == null
    )
      plan.returnTotal = false;
    // Web API $count=true counts the matching rows like returntotalrecordcount.
    if (options.returnTotal === true && plan.top == null && !plan.aggregate) plan.returnTotal = true;
    const permissionLinkNodes = new Set(
      (options.permissionQuery?.generatedLinkOrdinals ?? []).map((index) => plan.links[index]).filter(Boolean),
    );
    const nativeBackend =
      options.portalRequest === true &&
      this.observed?.tablePermissionQueryPipeline === 'native-classic' &&
      options.permissionQuery?.permissionGranted;
    const rawQueryNodes = nativeBackend ? new Set([plan.root, ...plan.links]) : undefined;
    const ctx = this.queryContext(identity, { ...options, permissionLinkNodes, rawQueryNodes });
    return executeFetch(plan, {
      mapping: (name) => this.resolveMapping(name),
      relationships: ctx.relationships,
      readableRows: options.noBackendAdmission ? () => [] : ctx.readRows,
      permissionLink: (node) => permissionLinkNodes.has(node),
      permissionTerminalConditions: options.permissionQuery?.generatedTerminalConditions ?? [],
      nativePagingCookies:
        options.portalRequest === true && this.observed?.tablePermissionQueryPipeline === 'native-classic',
      tableRows: (logical) => this.tableRows(logical),
      datasourceRows: (source, logical) => {
        const rows =
          (identity?.dataverse ? this.datasourceRows?.(source, logical, identity, { plan, options }) : undefined) ?? [];
        const kept = options.backendRowsFilter
          ? rows.filter((row) => options.backendRowsFilter(logical, row) === true)
          : rows;
        const mask = options.backendRowsMask?.(logical);
        return mask ? kept.map(mask) : kept;
      },
      definition: ctx.definition,
      column: ctx.column,
      sortable: (logical, attribute) => this.sortableColumn(logical, attribute),
      lookupName: ctx.lookupName,
      identity,
      settings: options.noBackendAdmission ? { ...ctx.settings, fetchAllWithoutFilter: undefined } : ctx.settings,
      now: ctx.now,
      platformLanguageCode: options.platformLanguageCode,
      equalRows: options.fetchCache
        ? (rows, column, value) => options.fetchCache.equalRows(rows, column, value)
        : undefined,
    });
  }
}

function boundedInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new DataError(`${name} must be a nonnegative integer`);
  return n;
}
function project(row, select) {
  if (!select || select === '*') return clone(row);
  const out = new Map();
  for (const key of Array.isArray(select) ? select : splitTop(select)) {
    out.set(key, field(row, key) ?? null);
    if (key.startsWith('_') && key.endsWith('_value')) {
      const lookup = row[key.slice(1, -6)];
      if (lookup && typeof lookup === 'object' && own(lookup, 'id')) {
        out.set(key + formattedAnnotation, lookup.name ?? '');
        if (lookup.logical_name) out.set(key + lookupAnnotation, lookup.logical_name);
      }
    }
  }
  return Object.fromEntries(out);
}

/**
 * Parse an entity reference used by @odata.bind/@odata.id: absolute portal
 * URLs, /_api/set(key), /set(key) or set(key). The caller checks origins.
 */
export function parseEntityReference(value) {
  let text = String(value ?? '').trim();
  let origin = null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.search || url.hash || url.username || url.password) return null;
    origin = url.origin;
    text = decodeURIComponent(url.pathname);
  }
  text = text.replace(/^\/?_api\//, '').replace(/^\//, '');
  const match = /^([A-Za-z_]\w*)\(([^()]+)\)$/.exec(text);
  if (!match) return null;
  const key = match[2].trim();
  return {
    set: match[1],
    id: /=/.test(key) ? key : key.replace(/^'(.*)'$/, '$1').replace(/^\{(.*)\}$/, '$1'),
    origin,
  };
}
/** Alternate key segment `a='x',b=2` as a column map; null for a primary key. */
export function parseKeySegment(key) {
  const text = String(key ?? '').trim();
  if (!text.includes('=')) return null;
  const parts = {};
  let index = 0;
  const whitespace = () => {
    while (index < text.length && /\s/.test(text[index])) index++;
  };
  const invalid = () => {
    throw new DataError('Invalid alternate key segment', 400, 'InvalidKey');
  };
  while (index < text.length) {
    whitespace();
    const nameStart = index;
    if (!/[A-Za-z_]/.test(text[index] ?? '')) invalid();
    index++;
    while (index < text.length && /\w/.test(text[index])) index++;
    const name = text.slice(nameStart, index).toLowerCase();
    if (['__proto__', 'prototype', 'constructor'].includes(name) || own(parts, name)) invalid();
    whitespace();
    if (text[index++] !== '=') invalid();
    whitespace();
    const valueStart = index;
    if (text[index] === "'") {
      index++;
      let closed = false;
      while (index < text.length) {
        if (text[index++] !== "'") continue;
        if (text[index] === "'") {
          index++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) invalid();
    } else {
      while (index < text.length && text[index] !== ',') index++;
    }
    const raw = text.slice(valueStart, index).trim();
    if (!raw) invalid();
    whitespace();
    if (index < text.length && text[index++] !== ',') invalid();
    parts[name] = raw.startsWith("'")
      ? raw.slice(1, -1).replace(/''/g, "'")
      : /^-?\d+(?:\.\d+)?$/.test(raw)
        ? parseNumericLiteral(raw)
        : raw.replace(/^\{(.*)\}$/, '$1');
  }
  return parts;
}
/** The column's imported MinValue/MaxValue bound a numeric write (Dataverse validation). */
function assertBounds(value, definition, code, innerCode, { entity, attribute, kind }) {
  const min = Number(definition.minValue),
    max = Number(definition.maxValue);
  if (
    (definition.minValue != null && Number.isFinite(min) && compareNumeric(value, definition.minValue) < 0) ||
    (definition.maxValue != null && Number.isFinite(max) && compareNumeric(value, definition.maxValue) > 0)
  ) {
    const text = isExactNumeric(value) ? value.value : value;
    const message =
      kind === 'integer'
        ? `A validation error occurred. The value ${text} of '${attribute}' on record of type '${entity}' is outside the valid range. Minimum Value: ${definition.minValue ?? ''}, Maximum value: ${definition.maxValue ?? ''}`
        : `A validation error occurred for ${entity}.${attribute}. The value ${text} of type ${kind === 'money' ? 'Microsoft.Xrm.Sdk.Money' : kind === 'double' ? 'System.Double' : 'System.Decimal'} is outside the valid range(${definition.minValue ?? ''} to ${definition.maxValue ?? ''}).`;
    throw new DataError(message, 400, code, {
      innerCode,
      minValue: definition.minValue ?? null,
      maxValue: definition.maxValue ?? null,
    });
  }
}
/** A choice write must be one of the column's exported options (PicklistValueOutOfRange). */
function assertOption(value, definition, { entity, attribute }) {
  const options = Array.isArray(definition.options) ? definition.options : [];
  if (
    definition.optionSetOpen !== true &&
    options.length &&
    !options.some((option) => Number(option?.value) === value)
  ) {
    if (['state', 'status'].includes(String(definition.dataverseType ?? definition.type ?? '').toLowerCase()))
      throw new DataError(
        'State code is invalid or state code is valid but status code is invalid for a specified state code.',
        400,
        'InvalidStateCodeStatusCode',
        { innerCode: '0x80048408' },
      );
    throw new DataError(
      `A validation error occurred. The value ${value} of '${attribute}' on record of type '${entity}' is outside the valid range. Accepted Values: ${options.map((option) => option.value).join(',')}`,
      400,
      'PicklistValueOutOfRange',
      { innerCode: '0x8004431a', value },
    );
  }
}
/** Validate and normalise one Web API column value from its Dataverse type. */
function coerceValue(entity, attribute, value, definition, options = {}) {
  const kind = fieldKind(definition);
  if (
    isExactNumeric(value) &&
    !['integer', 'decimal', 'money', 'double'].includes(kind) &&
    !options.dataverseHttpReader
  )
    throw new DataError(
      'An exact numeric value cannot be stored in nonnumeric column ' + entity + '.' + attribute,
      400,
      'InvalidValue',
      { innerCode: '0x80048d19' },
    );
  // An exact numeric echoes the literal the client sent (its digits), never the internal marker object.
  const literal = isExactNumeric(value)
    ? value.value
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  const originalValue = value;
  const conversion = (type) =>
    attachDataverseReaderDetails(
      attachODataReaderDetails(
        new DataError(`Cannot convert the literal '${literal}' to the expected type '${type}'.`, 400, 'InvalidValue', {
          innerCode: '0x80048d19',
        }),
        options.odataErrorDetails ? odataConversionDetails(originalValue, type, attribute, options) : null,
      ),
      originalValue,
      attribute,
      options.dataverseHttpReader,
      type,
    );
  if (
    isExactNumeric(value) &&
    !['integer', 'decimal', 'money', 'double'].includes(kind) &&
    options.dataverseHttpReader
  ) {
    const expected =
      kind === 'string' || kind === 'multichoice'
        ? 'Edm.String'
        : kind === 'boolean'
          ? 'Edm.Boolean'
          : kind === 'choice'
            ? 'Edm.Int32'
            : kind === 'datetime'
              ? isDateOnlyField(definition)
                ? 'Edm.Date'
                : 'Edm.DateTimeOffset'
              : null;
    if (expected) throw conversion(expected);
    throw new DataError(
      'An exact numeric value cannot be stored in nonnumeric column ' + entity + '.' + attribute,
      400,
      'InvalidValue',
      { innerCode: '0x80048d19' },
    );
  }
  if (options.dataverseHttpReader && ['decimal', 'money'].includes(kind)) {
    const compatible = options.dataverseHttpReader.ieee754Compatible === true;
    if (typeof value === 'string') {
      if (!compatible) throw conversion('Edm.Decimal');
      const parsed = parseDataverseDecimalString(value);
      if (parsed === null) throw conversion('Edm.Decimal');
      value = parsed;
    } else if (compatible && (typeof value === 'number' || isExactNumeric(value))) throw conversion('Edm.Decimal');
  }
  switch (kind) {
    case 'string': {
      if (typeof value !== 'string') throw conversion('Edm.String');
      // The Web API rejects a NUL character in text.
      if (options.dataverseWebApi && value.includes('\u0000'))
        throw new DataError(
          `Invalid character in field '${attribute}': '.', hexadecimal value 0x00, is an invalid character.`,
          400,
          'InvalidValue',
          { innerCode: '0x80040278' },
        );
      if (value === '') return null;
      const max = Number(definition.maxLength);
      if (Number.isFinite(max) && max > 0 && value.length > max)
        throw new DataError(
          `A validation error occurred.  The length of the '${attribute}' attribute of the '${entity}' entity exceeded the maximum allowed length of '${max}'.`,
          400,
          'StringLengthExceeded',
          { innerCode: '0x80044331' },
        );
      // Email is a schema format, independent of the column/table name. Length
      // validation applies to the submitted value before normalization. A memo column's
      // Email format is an email body (MemoFormatName), not an address: it stays as written.
      const declared = String(definition.dataverseType ?? definition.type ?? '').toLowerCase();
      const email =
        (declared !== 'memo' && String(definition.format ?? '').toLowerCase() === 'email') || declared === 'email';
      return email ? value.trim().toLowerCase() || null : value;
    }
    case 'integer': {
      const int64 = String(definition.dataverseType ?? definition.type ?? '').toLowerCase() === 'bigint';
      const type = int64 ? 'Edm.Int64' : 'Edm.Int32';
      if (int64 && (isExactNumeric(value) || (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())))) {
        const parts = decimalParts(typeof value === 'string' ? value.trim() : value);
        if (
          !parts ||
          parts.scale !== 0 ||
          compareNumeric(value, '-9223372036854775808') < 0 ||
          compareNumeric(value, '9223372036854775807') > 0 ||
          (isExactNumeric(value) && !['Literal', 'Int64'].includes(value.numericType))
        )
          throw conversion(type);
        value = exactNumeric(parts.coefficient.toString(), 'Int64');
        assertBounds(value, definition, 'IntegerValueOutOfRange', '0x8004432f', { entity, attribute, kind });
        return value;
      }
      if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) value = Number(value.trim());
      if (typeof value !== 'number' || !Number.isInteger(value)) throw conversion(type);
      // A literal outside Edm.Int32 doesn't convert; MinValue/MaxValue narrow the column.
      if (int64 ? !Number.isSafeInteger(value) : value < -2147483648 || value > 2147483647) throw conversion(type);
      assertBounds(value, definition, 'IntegerValueOutOfRange', '0x8004432f', { entity, attribute, kind });
      return value;
    }
    case 'decimal':
    case 'money':
    case 'double': {
      if (isExactNumeric(value) && kind !== 'double') {
        if (!['Literal', kind === 'money' ? 'Money' : 'Decimal'].includes(value.numericType))
          throw conversion('Edm.Decimal');
        const parts = decimalParts(value);
        if (
          !parts ||
          parts.scale > 28 ||
          compareNumeric(value, '-79228162514264337593543950335') < 0 ||
          compareNumeric(value, '79228162514264337593543950335') > 0
        )
          throw conversion('Edm.Decimal');
        const result = roundNumeric(
          value,
          Number.isInteger(definition.precision) ? definition.precision : 2,
          kind === 'money' ? 'Money' : 'Decimal',
        );
        assertBounds(result, definition, 'DecimalValueOutOfRange', '0x80044330', { entity, attribute, kind });
        return result;
      }
      if (isExactNumeric(value) && kind === 'double' && value.numericType === 'Literal') value = Number(value.value);
      // The Web API parses Infinity text and then rejects it as outside the column's range.
      if (kind === 'double' && options.dataverseWebApi && (value === 'Infinity' || value === '-Infinity'))
        throw new DataError(
          `A validation error occurred for ${entity}.${attribute}. The value ${value === 'Infinity' ? '∞' : '-∞'} of type System.Double is outside the valid range(${definition.minValue ?? ''} to ${definition.maxValue ?? ''}).`,
          400,
          'DecimalValueOutOfRange',
          { innerCode: '0x80044330' },
        );
      if (
        kind === 'double' &&
        typeof value === 'string' &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
      )
        value = Number(value.trim());
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw conversion(kind === 'double' ? 'Edm.Double' : 'Edm.Decimal');
      const precision = Number.isInteger(definition.precision) ? definition.precision : kind === 'double' ? null : 2;
      let result = value;
      if (precision != null) {
        // Decimal half-away-from-zero rounding on the decimal digits, not the
        // binary approximation (10.555 -> 10.56 like SQL decimal conversion).
        const text = String(Math.abs(value));
        if (/e/i.test(text)) result = Number(value.toFixed(precision));
        else {
          const rounded = Number(`${Math.round(Number(`${text}e${precision}`))}e-${precision}`);
          result = value < 0 ? -rounded : rounded;
        }
      }
      // The documented DecimalValueOutOfRange covers money and float columns too; their
      // own codes aren't documented.
      assertBounds(result, definition, 'DecimalValueOutOfRange', '0x80044330', { entity, attribute, kind });
      return result;
    }
    case 'boolean':
      if (typeof value === 'string' && /^(true|false)$/i.test(value.trim()))
        value = value.trim().toLowerCase() === 'true';
      if (typeof value !== 'boolean') throw conversion('Edm.Boolean');
      return value;
    case 'choice': {
      let raw = value && typeof value === 'object' ? value.value : value;
      if (typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim())) raw = Number(raw.trim());
      if (typeof raw !== 'number' || !Number.isInteger(raw)) throw conversion('Edm.Int32');
      // A plain picklist accepts -1 on create and patch and reads it back. State, status and multiselect columns do not.
      if (
        options.dataverseWebApi &&
        raw === -1 &&
        String(definition.dataverseType ?? definition.type ?? '').toLowerCase() === 'picklist'
      )
        return raw;
      assertOption(raw, definition, { entity, attribute });
      return raw;
    }
    case 'multichoice': {
      // The Web API takes a comma-separated string of option values; an empty string, an array or a non-integer part is rejected.
      if (options.dataverseWebApi) {
        if (typeof value !== 'string') throw conversion('Edm.String');
        if (value.trim() === '')
          throw new DataError('Edm Object passed should have the options selected. ', 400, 'InvalidValue', {
            innerCode: '0x80060888',
          });
        const numbers = new Set();
        for (const part of value.split(',')) {
          const text = part.trim();
          // Native message for an empty part between commas not known.
          const number = /^[+-]?\d+$/.test(text) ? Number(text) : NaN;
          if (!Number.isInteger(number))
            throw new DataError(`The optionset values sent ${text} are not valid integers.`, 400, 'InvalidValue', {
              innerCode: '0x80060888',
            });
          assertOption(number, definition, { entity, attribute });
          numbers.add(number);
        }
        // Repeated choice values are stored once, in first-seen order.
        return [...numbers].join(',');
      }
      // The native form posts the MultiSelectPicklist control's JSON array of option metadata.
      if (typeof value === 'string' && /^\s*\[/.test(value)) {
        try {
          value = JSON.parse(value)
            .map((item) => (item && typeof item === 'object' ? item.Value : item))
            .join(',');
        } catch {
          throw conversion('Edm.String');
        }
      }
      const parts = Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? value.split(',').filter((part) => part.trim() !== '')
          : null;
      if (!parts) throw conversion('Edm.String');
      for (const part of parts) {
        const number = Number(typeof part === 'string' ? part.trim() : part);
        if (!Number.isInteger(number)) throw conversion('Edm.Int32');
        assertOption(number, definition, { entity, attribute });
      }
      return value;
    }
    case 'datetime': {
      if (typeof value !== 'string')
        throw conversion(options.dataverseWebApi && isDateOnlyField(definition) ? 'Edm.Date' : 'Edm.DateTimeOffset');
      // A DateOnly column reads only Edm.Date (yyyy-MM-dd); timestamps and impossible dates fail the OData reader.
      if (
        options.dataverseWebApi &&
        isDateOnlyField(definition) &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !parseDateValue(value))
      )
        throw conversion('Edm.Date');
      const parsed = parseDateValue(value);
      // Timestamp calendar/clock errors fail the OData primitive reader. Failed
      // date-text/zone conversion reaches Dataverse's CrmDateTime validation.
      const timestamp =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.exec(
          value.trim(),
        );
      if (
        !parsed &&
        timestamp &&
        (+timestamp[2] < 1 ||
          +timestamp[2] > 12 ||
          +timestamp[3] < 1 ||
          +timestamp[3] > 31 ||
          new Date(Date.UTC(+timestamp[1], +timestamp[2] - 1, +timestamp[3])).getUTCDate() !== +timestamp[3] ||
          +timestamp[4] > 23 ||
          +timestamp[5] > 59 ||
          +(timestamp[6] ?? 0) > 59)
      )
        throw conversion('Edm.DateTimeOffset');
      const year = parsed ? new Date(parsed.ms).getUTCFullYear() : NaN;
      if (!parsed || year < 1753 || year > 9999) throw dateTimeRangeError(value, parsed);
      return isDateOnlyField(definition) ? isoUtc(parsed.ms, { dateOnly: true }) : isoUtc(parsed.ms);
    }
    case 'guid':
      if (typeof value !== 'string' || !GUID_PATTERN.test(value)) throw conversion('Edm.Guid');
      return value.toLowerCase();
    default:
      return value;
  }
}
