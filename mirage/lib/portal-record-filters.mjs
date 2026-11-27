/*
 * The record filters of the security roles Power Pages generates for web roles under enhanced authorization (the
 * FetchXML of each recordfilter row; record-filter.mjs evaluates them). Their shapes are those a hosted site generated
 * (session F1, 2026-11-26, summary-F1.md AUTH-02d; a disposable site with one web role per scope, read back from
 * roleprivileges, recordfilter and entityrecordfilter):
 *
 * - every scope's privilege has depth 16 (record filter); the permissions of one role on one privilege are the branches
 *   of one `<filter type="and"><filter type="or">...</filter></filter>`, and a Global permission makes the filter the
 *   unfiltered `<entity name="x" />`;
 * - Contact (lookup F to contact): `<link-entity name="contact" from="contactid" to="F" link-type="any">` holding the
 *   visitor's `powerpagesusermapping` (contact = contactid, systemuser eq-userid, link-type inner);
 * - Account (lookup F to account): `<link-entity name="account" from="accountid" to="F" link-type="any">` holding the
 *   mapping whose parentcustomerid is that account;
 * - Self: the mapping linked to the row itself (`from="contact" to="contactid" link-type="any"`);
 * - Parent: `<filter type="and">` with, on an activity table, `activitytypecode eq <object type code>`, and the parent
 *   table linked through the relationship (`link-type="any"`) holding the parent permission's own branch (nothing for a
 *   Global parent);
 * - Custom Access: the permission's root filter;
 * - an activity table's filters are rooted at activitypointer (activity privileges are shared), so Global on one activity
 *   table reaches every activity type.
 *
 * Every generated role also reads the visitor's own contact and parent account (16), the user mappings (16, an empty
 * filter: every row) and, at Global (8), table metadata and SharePoint data.
 *
 * A scope whose relationship the FetchXML cannot express (a many-to-many parent link, an identity relationship) gets a
 * branch that admits nothing, so a record filter never reaches more than its permission's scope.
 */
import { xmlEscapeAttribute } from './fetchxml-engine.mjs';
import { permissionGrantColumn } from './odata-permission-query.mjs';
import { customTablePermissionFilter } from './custom-table-permission.mjs';
import { ACTIVITY_ROOT, tableTypeCode } from './record-filter.mjs';

const attr = (value) => xmlEscapeAttribute(String(value ?? ''));
const MAPPING_CONDITION = '<filter><condition attribute="systemuser" operator="eq-userid" /></filter>';
const mapping = (from, to, type) =>
  `<link-entity name="powerpagesusermapping" from="${attr(from)}" to="${attr(to)}" link-type="${type}">${MAPPING_CONDITION}</link-entity>`;
const NEVER = (idColumn) => `<filter type="and"><condition attribute="${attr(idColumn)}" operator="null" /></filter>`;

/** The branch selecting the visitor's own contact row (Self scope on contact; the implicit contact read). */
const OWN_CONTACT_BRANCH = mapping('contact', 'contactid', 'any');
/** The branch selecting the visitor's parent account (the implicit account read of every generated role). */
const PARENT_ACCOUNT_BRANCH = `<link-entity name="contact" from="parentcustomerid" to="accountid" link-type="any">${mapping('contact', 'contactid', 'inner')}</link-entity>`;

/** Privileges every generated role holds besides its table permissions: [privilege, depth, branch or null (Global)]. */
export const IMPLICIT_ROLE_GRANTS = Object.freeze([
  ['prvReadContact', 'contact', OWN_CONTACT_BRANCH],
  ['prvReadAccount', 'account', PARENT_ACCOUNT_BRANCH],
  // An empty filter (hosted: `<filter type="or" />`) adds no condition.
  ['prvReadPowerPagesUserMapping', 'powerpagesusermapping', ''],
]);
export const IMPLICIT_GLOBAL_PRIVILEGES = Object.freeze([
  'prvReadAsyncOperation',
  'prvReadAttribute',
  'prvReadAttributeMap',
  'prvReadEntity',
  'prvReadEntityKey',
  'prvReadEntityMap',
  'prvReadPluginAssembly',
  'prvReadPluginType',
  'prvReadRelationship',
  'prvReadSdkMessage',
  'prvReadSdkMessageProcessingStep',
  'prvReadSdkMessageProcessingStepImage',
  'prvCreateSharePointData',
  'prvReadSharePointData',
  'prvWriteSharePointData',
  'prvReadSharePointDocument',
]);

function serializeFilter(node) {
  if (node.name === 'condition') {
    const attrs = Object.entries(node.attrs)
      .map(([name, value]) => ` ${name}="${attr(value)}"`)
      .join('');
    if (!node.children?.length) return `<condition${attrs} />`;
    const values = node.children.map((value) => '<value>' + attr(value.text) + '</value>').join('');
    return `<condition${attrs}>${values}</condition>`;
  }
  return `<filter type="${attr(node.attrs.type ?? 'and')}">${node.children.map(serializeFilter).join('')}</filter>`;
}

/**
 * The record filter branch of one table permission on table `logical`, relative to that table:
 * { global: true } or { branch } (FetchXML filter/link-entity markup). `context`: { mappingOf(logical), byRule, activity(logical) }.
 */
export function scopeBranch(rule, logical, context, seen = new Set()) {
  const scope = rule.scope ?? 'global';
  const tableMapping = context.mappingOf(logical);
  const idColumn = tableMapping?.idColumn ?? `${logical}id`;
  if (scope === 'global') return { global: true };
  if (rule.identityRelationship || rule.observedOrphanParent) return { branch: NEVER(idColumn) };
  let inner;
  if (scope === 'contact')
    inner = `<link-entity name="contact" from="contactid" to="${attr(permissionGrantColumn(rule, idColumn))}" link-type="any">${mapping('contact', 'contactid', 'inner')}</link-entity>`;
  else if (scope === 'account')
    inner = `<link-entity name="account" from="accountid" to="${attr(permissionGrantColumn(rule, idColumn))}" link-type="any">${mapping('parentcustomerid', 'accountid', 'inner')}</link-entity>`;
  else if (scope === 'self') inner = mapping('contact', idColumn, 'any');
  else if (scope === 'custom') {
    try {
      inner = serializeFilter(customTablePermissionFilter(rule.permissionFetchXml, logical));
    } catch {
      inner = NEVER(idColumn);
    }
  } else if (scope === 'parent') inner = parentBranch(rule, context, seen, idColumn);
  else inner = NEVER(idColumn);
  if (!context.activity(logical)) return { branch: inner };
  // Activity filters are rooted at activitypointer: the branch names the activity type.
  return {
    branch: `<filter type="and"><condition attribute="activitytypecode" operator="eq" value="${tableTypeCode(context.store, logical)}" />${inner}</filter>`,
  };
}

function parentBranch(rule, context, seen, idColumn) {
  const relationship = rule.relationship;
  const parent = context.byRule.get(String(rule.parentPermissionId ?? rule.parentId ?? '').toLowerCase());
  if (!parent || seen.has(parent) || !relationship?.entity || !relationship.from || !relationship.to)
    return NEVER(idColumn);
  if (relationship.intersect) return NEVER(idColumn);
  const parentTable = relationship.entity;
  const nested = scopeBranch(parent, parentTable, { ...context, activity: () => false }, new Set([...seen, rule]));
  const body = nested.global ? '' : nested.branch;
  return `<filter type="and"><link-entity name="${attr(parentTable)}" from="${attr(relationship.to)}" to="${attr(relationship.from)}" link-type="any">${body}</link-entity></filter>`;
}

/** The recordfilter FetchXML for a privilege's branches: unfiltered for a Global grant. */
export function recordFilterFetchXml(root, { global, branches }) {
  if (global) return `<fetch mapping="logical"><entity name="${attr(root)}" /></fetch>`;
  return `<fetch mapping="logical"><entity name="${attr(root)}"><filter type="and"><filter type="or">${[...branches].join('')}</filter></filter></entity></fetch>`;
}

/** The table a privilege's record filter is rooted at. */
export const recordFilterRoot = (logical, activity) => (activity ? ACTIVITY_ROOT : logical);
