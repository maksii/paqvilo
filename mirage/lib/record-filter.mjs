/*
 * Record filters: the privilege depth a Dataverse security role grants as 16 (record filter) instead of Basic, Local, Deep
 * or Global. A role privilege at that depth points at a recordfilter row whose FetchXML selects the rows the privilege
 * reaches for the calling user (operator eq-userid). Hosted Power Pages generates one per privilege of the security role
 * it maps to a web role when enhanced authorization is enabled (session F1, summary-F1.md AUTH-02d): for example a
 * Contact scope reads `<link-entity name="contact" ...><link-entity name="powerpagesusermapping" ...><condition
 * attribute="systemuser" operator="eq-userid"/>`, and Global is the unfiltered `<entity name="x"/>`.
 *
 * recordFilterAdmits evaluates one filter against one row: root conditions and filters, and link-entity joins (inner,
 * any, not any) resolved against the store's rows of the linked table. An empty filter adds no condition (a hosted
 * generated filter `<filter type="or"/>` admits every row). Anything else (another link type, an unknown operator, a
 * FetchXML that does not parse, a root that names another table) admits nothing: a record filter never widens a grant.
 */
import { parseXmlDocument, fieldValue } from './fetchxml-engine.mjs';
import { compileOperator } from './dataverse-conditions.mjs';
import { guidKey } from './dataverse-values.mjs';

/** The privilege depth mask of a record-filter grant (roleprivileges.privilegedepthmask). */
export const RECORD_FILTER_DEPTH = 16;
// The table every activity table's record filter is rooted at (activity privileges are shared: prvReadActivity, ...).
export const ACTIVITY_ROOT = 'activitypointer';

// A table's object type code: its exported metadata, else the organization's metadata service (store.objectTypeCode, set by
// dataverse-organization.mjs), as dataverse-metadata.mjs numbers tables. Taken from the store, so this module imports no
// metadata service. A store without either answers null.
export function tableTypeCode(store, logical) {
  let mapping;
  try {
    mapping = store?.resolveMapping?.(logical);
  } catch {
    mapping = undefined;
  }
  return mapping?.dataverseMetadata?.ObjectTypeCode ?? store?.objectTypeCode?.(logical) ?? null;
}

const key = (value) => {
  const raw = value !== null && typeof value === 'object' ? (value.id ?? value.value) : value;
  if (raw == null || raw === '') return null;
  return guidKey(raw) ?? String(raw).toLowerCase();
};
const LIMIT = 2000;
const parsed = new Map();

function parse(fetchXml) {
  if (parsed.has(fetchXml)) return parsed.get(fetchXml);
  let entity;
  try {
    const fetch = parseXmlDocument(String(fetchXml ?? ''), { root: 'fetch', maxDepth: 20 });
    const entities = fetch.children.filter((element) => element.name === 'entity');
    entity = entities.length === 1 ? entities[0] : null;
  } catch {
    entity = null;
  }
  if (parsed.size >= LIMIT) parsed.clear();
  parsed.set(fetchXml, entity);
  return entity;
}

// activitytypecode on an activity row: the row's own value (activitypointer projections carry the logical name), else the
// table being admitted; a numeric operand compares object type codes, a text operand logical names.
function activityTypeTest(condition, logical, context) {
  const values = Object.hasOwn(condition.attrs, 'value')
    ? [condition.attrs.value]
    : condition.children.filter((child) => child.name === 'value').map((child) => child.text);
  const matches = (row) => {
    const type = String(row.activitytypecode ?? logical).toLowerCase();
    return values.some((value) =>
      /^\d+$/.test(String(value).trim())
        ? Number(value) === context.typeCode(type)
        : String(value).trim().toLowerCase() === type,
    );
  };
  const operator = condition.attrs.operator;
  if (operator === 'eq' || operator === 'in') return matches;
  if (operator === 'ne' || operator === 'neq' || operator === 'not-in') return (row) => !matches(row);
  return () => false;
}

function conditionTest(condition, context, logical) {
  const { attribute, operator } = condition.attrs;
  if (!attribute || !operator) return () => false;
  if (attribute.toLowerCase() === 'activitytypecode') return activityTypeTest(condition, logical, context);
  const values = Object.hasOwn(condition.attrs, 'value')
    ? [condition.attrs.value]
    : condition.children.filter((child) => child.name === 'value').map((child) => child.text);
  try {
    const predicate = compileOperator(operator, {
      attribute: `${logical}.${attribute}`,
      values,
      definition: context.definition(logical, attribute),
      identity: { systemUserId: context.userId },
      table: logical,
    });
    return (row) => {
      try {
        return Boolean(predicate(fieldValue(row, attribute)));
      } catch {
        return false;
      }
    };
  } catch {
    return () => false;
  }
}

function filterTest(filter, context, logical) {
  const type = filter.attrs.type ?? 'and';
  const tests = [];
  for (const child of filter.children) {
    if (child.name === 'condition') tests.push(conditionTest(child, context, logical));
    else if (child.name === 'filter') tests.push(filterTest(child, context, logical));
    else if (child.name === 'link-entity') tests.push(linkTest(child, context));
    else return () => false;
  }
  if (!tests.length) return () => true;
  if (type === 'or') return (row) => tests.some((test) => test(row));
  if (type === 'and') return (row) => tests.every((test) => test(row));
  return () => false;
}

// The children of an entity or link-entity: every filter holds and every nested join finds a row.
function entityTest(node, context, logical) {
  const tests = [];
  for (const child of node.children) {
    if (child.name === 'filter') tests.push(filterTest(child, context, logical));
    else if (child.name === 'link-entity') tests.push(linkTest(child, context));
    else if (!['attribute', 'all-attributes', 'order'].includes(child.name)) return () => false;
  }
  return (row) => tests.every((test) => test(row));
}

function linkTest(link, context) {
  const { name, from, to } = link.attrs;
  const type = link.attrs['link-type'] ?? 'inner';
  if (!name || !from || !to || !['inner', 'any', 'not any'].includes(type)) return () => false;
  const linked = String(name).toLowerCase();
  const inner = entityTest(link, context, linked);
  return (row) => {
    const value = key(fieldValue(row, to));
    const found =
      value != null &&
      context.rows(linked).some((candidate) => key(fieldValue(candidate, from)) === value && inner(candidate));
    return type === 'not any' ? !found : found;
  };
}

/**
 * Whether `fetchXml` admits `row` of table `logical` for the user `userId`. `store` supplies the rows of linked tables and
 * the column metadata. The root must name `logical`, or activitypointer for an activity table (`activity` true).
 */
export function recordFilterAdmits(fetchXml, { store, userId = null, logical, activity = false }, row) {
  const entity = parse(fetchXml);
  if (!entity || !row) return false;
  const root = String(entity.attrs.name ?? '').toLowerCase();
  if (root !== String(logical).toLowerCase() && !(activity && root === ACTIVITY_ROOT)) return false;
  const context = {
    userId: key(userId),
    rows: (table) => store.tableRows(table) ?? [],
    typeCode: (table) => tableTypeCode(store, table),
    definition: (table, attribute) => {
      try {
        const mapping = store.resolveMapping(table);
        return mapping?.fields?.[attribute] ?? mapping?.fieldMetadata?.[attribute];
      } catch {
        return undefined;
      }
    },
  };
  return entityTest(entity, context, String(logical).toLowerCase())(row);
}
