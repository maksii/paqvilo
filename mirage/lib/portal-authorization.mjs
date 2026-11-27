/*
 * The Power Pages authorization bridge: one place every portal entry point reaches (data.mjs rules(), the row mask of
 * queryContext() and get(), the portal Web API column policy and write context, server logic's InvokeCustomApi principal).
 *
 * enhancedauthorization (powerpagesite table): 0 Disabled, 1 Migration in progress, 2 Migration Failed, 3 Enabled.
 * - standard model (0, 1 and 2; see portalAuthorizationModel): table and record permissions are evaluated after retrieval from Dataverse, as the Power Pages
 *   application user. The store evaluates table permissions and the Web API column permissions.
 * - enhanced model: each contact maps to a system user per site and each web role to a security role holding the web
 *   role's permissions; Dataverse operations impersonate the site user, and Dataverse column security profiles replace the
 *   Web API column permissions (https://learn.microsoft.com/power-pages/security/unify-pages-security-with-dataverse).
 *   Column security applies to every Power Pages component and API, anonymous visitors included.
 *
 * Enhanced evaluation here: prepare() derives one security role per web role from the table permissions (privilege per
 * operation and table at depth 16, record filter, each with the recordfilter row a hosted site generates for its scopes:
 * portal-record-filters.mjs) and one system user per contact and site (plus one anonymous user per site) holding the
 * security roles of the visitor's web roles, with the visitor's powerpagesusermapping row (contact, systemuser,
 * parentcustomerid) the record filters join through. A table permission then grants only when the mapped user holds, through the
 * security role of one of the permission's web roles, the Dataverse privilege for the operation: an administrator who removes
 * the privilege from that role in Dataverse revokes the grant. Rows read are masked by the field security profiles of the
 * mapped user (dataverse-fls.mjs rowMask), and portal writes run as the mapped user, called by the site's application user
 * (impersonation), so the record pipeline's column security hooks apply to them.
 */
import { DataError } from './data-error.mjs';
import {
  ACCESS_MODE,
  DEPTH,
  applyRoleGrants,
  removeRoleGrants,
  grantTablePrivileges,
  privilegeId,
  privilegeName,
  uuidV5,
} from './dataverse-security.mjs';
import { portalWebRoles } from './permissions.mjs';
import { SYSTEM_ADMINISTRATOR_STAND_IN } from './dataverse-fls.mjs';
import { ENHANCED_AUTHORIZATION_ENABLED, ENHANCED_AUTHORIZATION_STATES } from './platform-changes.mjs';
import { CUSTOM_ACCESS_ENABLED_STATE } from './custom-table-permission.mjs';
import { RECORD_FILTER_DEPTH } from './record-filter.mjs';
import { standardTableDef } from './dataverse-standard.mjs';
import {
  IMPLICIT_GLOBAL_PRIVILEGES,
  IMPLICIT_ROLE_GRANTS,
  recordFilterFetchXml,
  recordFilterRoot,
  scopeBranch,
} from './portal-record-filters.mjs';

const key = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const field = (record, name) => record?.[`adx_${name}`] ?? record?.[`mspp_${name}`] ?? record?.[name];
const RIGHT = {
  read: 'Read',
  create: 'Create',
  update: 'Write',
  delete: 'Delete',
  append: 'Append',
  appendTo: 'AppendTo',
};
// Every table permission scope maps to depth 16 (record filter) with the record filter of its scope, as a hosted site
// generates them (session F1, summary-F1.md AUTH-02d; portal-record-filters.mjs). The records a portal grant reaches stay
// those its scope selects in data.mjs allowed(); the record filters decide what the mapped user reaches through Dataverse
// itself (a Canvas app or a workflow run as that user).
const COLUMN_PERMISSION_KINDS = new Set(['columnpermissionprofile', 'columnpermission']);

/** One privilege of a derived role: its record filter collects the branches of every permission granting it. */
function addGrant(
  grants,
  name,
  { logical, root, wildcard = false, implicit = false, mask = RECORD_FILTER_DEPTH, branch },
) {
  const grant = grants.get(name) ?? {
    logical,
    root,
    mask,
    wildcard,
    implicit,
    global: false,
    branches: new Set(),
  };
  grant.wildcard &&= wildcard;
  grant.implicit &&= implicit;
  if (mask === RECORD_FILTER_DEPTH) {
    if (branch?.global) grant.global = true;
    else if (branch?.branch != null) grant.branches.add(branch.branch);
  }
  grants.set(name, grant);
}

function addDerivedOperations(context, logical, grants) {
  const { rule, noun, activity } = context;
  const branch = scopeBranch(rule, logical, context);
  for (const operation of rule.operations ?? ['read']) {
    if (!RIGHT[operation]) continue;
    addGrant(grants, privilegeName(RIGHT[operation], noun(logical)), {
      logical,
      root: recordFilterRoot(logical, activity(logical)),
      wildcard: rule.entity === '*',
      branch,
    });
  }
}

function addDerivedRoleRule(context, roleId) {
  const { out, securityRoleId, rule, everyTable } = context;
  const grants = out.get(securityRoleId(roleId)).grants;
  for (const logical of rule.entity === '*' ? everyTable() : [rule.entity])
    addDerivedOperations(context, logical, grants);
}

// The grants every generated role holds besides its table permissions (portal-record-filters.mjs).
function addImplicitGrants(grants) {
  for (const [name, logical, branch] of IMPLICIT_ROLE_GRANTS)
    addGrant(grants, name, { logical, root: logical, implicit: true, branch: { branch } });
  for (const name of IMPLICIT_GLOBAL_PRIVILEGES)
    if (!grants.has(name)) grants.set(name, { logical: null, mask: DEPTH.Global, implicit: true, branches: new Set() });
}

function addDerivedRule(context) {
  const { roles, byId, rule, ruleRoles } = context;
  for (const roleId of ruleRoles(rule, roles)) {
    if (!byId.has(roleId)) continue;
    addDerivedRoleRule(context, roleId);
  }
}

function ensureKnownPrivilege(context, id, logical) {
  const { known, store, organizationId } = context;
  if (known.has(id) || !logical) return;
  try {
    for (const added of grantTablePrivileges(store, organizationId, logical))
      known.add(privilegeId(organizationId, added));
  } catch {
    /* reported by the caller when the required privilege is still unknown */
  }
}

function syncDerivedRole(context) {
  const {
    tables,
    roleId,
    role,
    marks,
    businessUnitRef,
    organizationRef,
    known,
    store,
    organizationId,
    signatureOf,
    markOf,
    storedGrants,
    diagnostic,
  } = context;
  const roles = (tables.role ??= []);
  const existing = roles.find((row) => key(row.roleid) === roleId);
  if (existing) existing.name = role.name;
  else
    roles.push({
      roleid: roleId,
      name: role.name,
      businessunitid: businessUnitRef,
      organizationid: organizationRef,
      isinherited: 1,
    });
  const signature = signatureOf(role.grants),
    mark = markOf(marks[roleId]);
  if (mark?.derived === signature) return;
  if (mark?.applied != null && storedGrants(roleId) !== mark.applied)
    diagnostic({
      code: 'PORTAL_AUTHORIZATION_ROLE_RESYNCED',
      severity: 'warning',
      model: 'enhanced',
      role: role.name,
      message: `The security role mapped to web role '${role.name}' was changed in Dataverse; the table permissions changed and rewrote it, which replaced that change.`,
    });
  const grants = [],
    filters = [];
  for (const [name, grant] of role.grants) {
    const id = privilegeId(organizationId, name);
    if (!grant.implicit) ensureKnownPrivilege({ known, store, organizationId }, id, grant.logical);
    if (known.has(id)) {
      if (grant.mask !== RECORD_FILTER_DEPTH) {
        grants.push({ privilegeid: id, mask: grant.mask });
        continue;
      }
      const filter = recordFilterRow(roleId, name, grant);
      filters.push(filter);
      grants.push({
        privilegeid: id,
        mask: grant.mask,
        recordFilterId: filter.recordfilterid,
        recordFilterName: filter.uniquename,
      });
    } else if (!grant.wildcard && !grant.implicit)
      diagnostic({
        code: 'PORTAL_AUTHORIZATION_PRIVILEGE_UNKNOWN',
        severity: 'warning',
        privilege: name,
        role: role.name,
        message: `Web role '${role.name}' grants ${name}, which the organization does not define; the grant is not mapped.`,
      });
  }
  replaceRecordFilters(tables, mark?.filters ?? [], filters);
  applyRoleGrants(store, roleId, grants);
  marks[roleId] = {
    derived: signature,
    applied: storedGrants(roleId),
    filters: filters.map((filter) => filter.recordfilterid),
  };
}

// The recordfilter row of one derived privilege (hosted unique names read Pages_<guid>).
function recordFilterRow(roleId, name, grant) {
  const id = uuidV5(roleId, `recordfilter:${name}`);
  return {
    recordfilterid: id,
    uniquename: `Pages_${id}`,
    displayname: `Pages_${name}`,
    fetchxml: recordFilterFetchXml(grant.root, grant),
    filterlinkedrecords: false,
    isrolebusinessunitquery: false,
  };
}

function replaceRecordFilters(tables, previous, filters) {
  const rows = (tables.recordfilter ??= []);
  const drop = new Set([...previous, ...filters.map((filter) => filter.recordfilterid)].map(key));
  for (let index = rows.length - 1; index >= 0; index--)
    if (drop.has(key(rows[index].recordfilterid))) rows.splice(index, 1);
  rows.push(...filters);
}

// The visitor's powerpagesusermapping row: its contact, mapped user and parent account (the columns the generated record
// filters join on). Anonymous visitors have none, so a filtered grant reaches nothing for them.
function syncUserMapping({ tables, identity, userId, contactOf, ref, name }) {
  const rows = (tables.powerpagesusermapping ??= []);
  const id = uuidV5(userId, 'powerpagesusermapping');
  const index = rows.findIndex((row) => key(row.powerpagesusermappingid) === id);
  const contact = contactOf(identity);
  if (!contact) {
    if (index >= 0) rows.splice(index, 1);
    return;
  }
  const row = {
    powerpagesusermappingid: id,
    contact: ref('contact', contact, name),
    systemuser: ref('systemuser', userId, name),
    parentcustomerid: identity.accountId ? ref('account', key(identity.accountId)) : null,
  };
  if (index >= 0) rows[index] = row;
  else rows.push(row);
}

/** Whether the visitor's stored user mapping row is current (see syncUserMapping). */
function userMappingCurrent(store, identity, userId, contactOf) {
  const id = uuidV5(userId, 'powerpagesusermapping');
  const row = store
    .tableRows('powerpagesusermapping')
    .find((candidate) => key(candidate.powerpagesusermappingid) === id);
  const contact = contactOf(identity);
  if (!contact) return !row;
  return Boolean(row) && key(row.contact) === contact && key(row.parentcustomerid) === key(identity.accountId);
}

function syncMappedUser(context) {
  const { tables, identity, userId, wanted, derived, businessUnitRef, organizationRef, contactOf, ref } = context;
  const users = (tables.systemuser ??= []);
  const name = String(
    identity.fullname || identity.name || (contactOf(identity) ? contactOf(identity) : 'Anonymous users'),
  );
  syncUserMapping({ tables, identity, userId, contactOf, ref, name });
  const user = users.find((row) => key(row.systemuserid) === userId);
  if (user) user.fullname = name;
  else
    users.push({
      systemuserid: userId,
      fullname: name,
      systemmanagedusertype: 1,
      accessmode: ACCESS_MODE.NonInteractive,
      isdisabled: false,
      businessunitid: businessUnitRef,
      organizationid: organizationRef,
    });
  const links = (tables.systemuserroles ??= []);
  for (let index = links.length - 1; index >= 0; index--)
    if (
      key(links[index].systemuserid) === userId &&
      derived.has(key(links[index].roleid)) &&
      !wanted.has(key(links[index].roleid))
    )
      links.splice(index, 1);
  for (const roleId of wanted)
    if (!links.some((row) => key(row.systemuserid) === userId && key(row.roleid) === roleId))
      links.push({
        systemuserroleid: uuidV5(userId, roleId),
        systemuserid: ref('systemuser', userId, name),
        roleid: ref('role', roleId, derived.get(roleId).name),
      });
}

/**
 * The model a site record selects: { state, label, model: 'standard' | 'enhanced' }.
 * Only 3 (Enabled) runs the enhanced model. Hosted evidence (session F1, 2026-11-26, two runs per state): in states 1
 * (Migration in progress) and 2 (Migration Failed) the portal still queries as its application user with the standard
 * permission FetchXML and ignores Custom Access, so both keep the standard model. An undocumented value runs the standard
 * model too.
 */
export function portalAuthorizationModel(website) {
  const state = Number(field(website, 'enhancedauthorization') ?? 0) || 0;
  const documented = Object.hasOwn(ENHANCED_AUTHORIZATION_STATES, state);
  const enhanced = state === ENHANCED_AUTHORIZATION_ENABLED;
  // An undocumented value reads as the standard model; the host records PORTAL_AUTHORIZATION_STATE_UNKNOWN for it.
  let label;
  if (documented) label = ENHANCED_AUTHORIZATION_STATES[state];
  else if (state === 0) label = 'Disabled';
  else label = `Unknown (${state})`;
  return {
    state,
    label,
    model: enhanced ? 'enhanced' : 'standard',
    ...(documented || state === 0 ? {} : { unknown: true }),
  };
}

/**
 * The bridge for one site and organization. website(): the site record; principals, fieldSecurity(): the organization's
 * (dataverse-security createPrincipals, api.fieldSecurity); applicationUser(): async, the site's application user id (the
 * caller of impersonated writes); diagnostic(entry): records a runtime diagnostic.
 */
export function createPortalAuthorization({
  store,
  website,
  portal,
  principals,
  fieldSecurity = () => null,
  organizationId,
  applicationUser = async () => null,
  existingApplicationUser = () => null,
  diagnostic = () => {},
}) {
  const describe = () => portalAuthorizationModel(website());
  const enhanced = (identity) => !identity?.admin && describe().model === 'enhanced';
  const siteId = () =>
    key(field(website(), 'websiteid') ?? field(website(), 'powerpagesiteid') ?? website()?.id ?? 'site');
  const webRoles = () => portalWebRoles(portal());
  const securityRoleId = (webRoleId) => uuidV5(organizationId, `portal-web-role:${siteId()}:${key(webRoleId)}`);
  const contactOf = (identity) => key(identity?.contactId ?? identity?.id) || null;
  // One site user per contact and site (Learn: "Multiple system user records can be created for a single contact")
  // and one per site for anonymous visitors (Learn column-security-profile: "Anonymous users represents all users accessing the
  // site without authentication"); the ids are local.
  const userIdOf = (identity) =>
    uuidV5(organizationId, `portal-site-user:${siteId()}:${contactOf(identity) ?? 'anonymous'}`);
  let applicationUserId = null;
  // Mapped users whose last sync failed: denied everything until a sync succeeds (fail closed; their old role links may be stale).
  const unusable = new Set();

  // A permission's web roles: its role ids, else the web roles its role names resolve to. A permission without a web role maps
  // to no security role, so it grants nothing in the enhanced model.
  const ruleRoles = (rule, roles) => {
    if (rule.roleIds?.length) return rule.roleIds.map(key);
    const names = new Set(rule.roles ?? []);
    return roles.filter((role) => names.has(role.name)).map((role) => role.id);
  };
  // Membership resolution already includes default roles and resolves exact IDs. Display names are for local overrides.
  const identityRoles = (identity, roles) => {
    const ids = new Set((identity.roleIds ?? []).map(key));
    if (identity.roleSource === 'memberships') return [...ids];
    const names = new Set(identity.roles ?? []);
    for (const role of roles) if (names.has(role.name)) ids.add(role.id);
    for (const role of roles) if (contactOf(identity) ? role.authenticated : role.anonymous) ids.add(role.id);
    return [...ids];
  };
  // Activity tables share the activity privileges (prvReadActivity, ...), custom activity tables included: a hosted site
  // granted a custom activity's permissions through them (session F1). Standard activity tables already resolve so.
  const activity = (logical) => {
    if (logical === 'activitypointer') return false;
    if (standardTableDef(logical)?.isActivity === true) return true;
    return store.state.mappings?.[logical]?.idColumn === 'activityid';
  };
  const noun = (logical) => principals.privilegeNoun(activity(logical) ? 'activitypointer' : logical);
  const mappingOf = (logical) => {
    try {
      return store.resolveMapping(logical);
    } catch {
      return null;
    }
  };

  // Security role id -> { name, grants: Map(privilege name -> { logical, mask, wildcard }) }, from the enabled table permissions.
  // A wildcard (*) permission expands to every mapped table that has privileges in the organization.
  function derivedRoles() {
    const roles = webRoles(),
      byId = new Map(roles.map((role) => [role.id, role]));
    const permissions = (store.state.permissions ?? []).filter((rule) => rule.enabled !== false && rule.entity);
    const everyTable = () =>
      Object.keys(store.state.mappings ?? {}).filter(
        (logical) => store.state.mappings[logical]?.dataverseOnly !== true,
      );
    const byRule = new Map(permissions.map((rule) => [key(rule.id), rule]));
    const out = new Map();
    for (const role of roles) out.set(securityRoleId(role.id), { name: role.name, grants: new Map() });
    for (const rule of permissions)
      addDerivedRule({
        out,
        roles,
        byId,
        rule,
        everyTable,
        byRule,
        ruleRoles,
        securityRoleId,
        noun,
        activity,
        mappingOf,
      });
    for (const role of out.values()) addImplicitGrants(role.grants);
    return out;
  }
  const signatureOf = (grants) =>
    [...grants]
      .map(([name, grant]) =>
        grant.mask === RECORD_FILTER_DEPTH
          ? `${name}:${grant.mask}:${recordFilterFetchXml(grant.root, grant)}`
          : `${name}:${grant.mask}`,
      )
      .sort(/* NOSONAR: preserve default string coercion */)
      .join('|');
  // The role's grants as stored in Dataverse, to see whether an administrator changed them since the last rewrite.
  const storedGrants = (roleId) =>
    store
      .tableRows('roleprivileges')
      .filter((row) => key(row.roleid) === roleId)
      .map((row) => `${key(row.privilegeid)}:${row.privilegedepthmask}`)
      .sort()
      .join('|');
  // Marks persisted per derived role: the permission signature it was written from and the grants written (older states: a string).
  const markOf = (mark) => (typeof mark === 'string' ? { derived: mark, applied: null } : (mark ?? null));

  // ponytail: prepare() recomputes the derived roles from every table permission on each portal request (O(permissions));
  // a permission revision counter on the store would let it skip unchanged requests.
  async function prepare(identity = {}) {
    if (!enhanced(identity)) return;
    try {
      applicationUserId ??= await applicationUser();
      const derived = derivedRoles(),
        userId = userIdOf(identity);
      const wanted = new Set(
        identityRoles(identity, webRoles())
          .map(securityRoleId)
          .filter((id) => derived.has(id)),
      );
      const marks = store.state.dataverse?.portalAuthorization?.roles ?? {};
      const linked = new Set(
        store
          .tableRows('systemuserroles')
          .filter((row) => key(row.systemuserid) === userId)
          .map((row) => key(row.roleid)),
      );
      const stale =
        unusable.has(userId) ||
        [...derived].some(
          ([roleId, role]) =>
            markOf(marks[roleId])?.derived !== signatureOf(role.grants) ||
            !store.tableRows('role').some((row) => key(row.roleid) === roleId),
        ) ||
        !store.tableRows('systemuser').some((row) => key(row.systemuserid) === userId) ||
        !userMappingCurrent(store, identity, userId, contactOf) ||
        [...derived.keys()].some((roleId) => linked.has(roleId) !== wanted.has(roleId)) ||
        Object.keys(marks).some((roleId) => !derived.has(roleId));
      if (stale) await store.transact(() => sync(derived, identity, userId, wanted));
      unusable.delete(userId);
    } catch (cause) {
      // Fail closed: until a sync succeeds every enhanced evaluation for this visitor denies, whatever links it still has.
      unusable.add(userIdOf(identity));
      diagnostic({
        code: 'PORTAL_AUTHORIZATION_SYNC_FAILED',
        severity: 'error',
        model: 'enhanced',
        message: `The enhanced authorization model could not map the visitor to Dataverse security: ${cause.message}`,
      });
    }
  }

  function sync(derived, identity, userId, wanted) {
    const tables = store.state.tables;
    const businessUnit = (tables.businessunit ?? []).find((row) => !key(row.parentbusinessunitid));
    if (!businessUnit)
      throw new DataError('The organization has no root business unit.', 503, 'OrganizationUnavailable');
    const ref = (logical, id, name = '') => ({ id, logical_name: logical, name });
    const businessUnitRef = ref('businessunit', businessUnit.businessunitid, businessUnit.name ?? '');
    const organizationRef = ref('organization', organizationId);
    const known = new Set((tables.privilege ?? []).map((row) => key(row.privilegeid)));
    store.state.dataverse ??= {};
    store.state.dataverse.portalAuthorization ??= { roles: {} };
    const marks = store.state.dataverse.portalAuthorization.roles;
    // The derived roles mirror the current web roles: the role of a web role that is gone loses its grants and user links.
    for (const roleId of Object.keys(marks))
      if (!derived.has(roleId)) {
        removeRoleGrants(store, roleId);
        replaceRecordFilters(tables, markOf(marks[roleId])?.filters ?? [], []);
        delete marks[roleId];
      }
    for (const [roleId, role] of derived)
      syncDerivedRole({
        tables,
        roleId,
        role,
        marks,
        businessUnitRef,
        organizationRef,
        known,
        store,
        organizationId,
        signatureOf,
        markOf,
        storedGrants,
        diagnostic,
      });
    syncMappedUser({ tables, identity, userId, wanted, derived, businessUnitRef, organizationRef, contactOf, ref });
  }

  // Security role id -> Set(privilege id) of its grants, rebuilt when roleprivileges change.
  let held = { revision: null, map: new Map() };
  const rolePrivileges = (roleId) => {
    const revision = store.tablesRevision?.(['roleprivileges']) ?? store.dataRevision();
    if (held.revision !== revision) {
      const map = new Map();
      for (const row of store.tableRows('roleprivileges')) {
        if (!(Number(row.privilegedepthmask) > 0)) continue; // NOSONAR: operand can be NaN or undefined, the negated test differs
        const id = key(row.roleid);
        if (!map.has(id)) map.set(id, new Set());
        map.get(id).add(key(row.privilegeid));
      }
      held = { revision, map };
    }
    return held.map.get(roleId) ?? new Set();
  };
  const mappedUser = (identity) => (unusable.has(userIdOf(identity)) ? null : principals.byId(userIdOf(identity)));
  // The security roles prepare() would link the visitor to and the privileges sync() would grant them (organization-defined only).
  const previewMapping = (identity) => {
    const derived = derivedRoles(),
      known = new Set(store.tableRows('privilege').map((row) => key(row.privilegeid)));
    return {
      roles: new Set(
        identityRoles(identity, webRoles())
          .map(securityRoleId)
          .filter((id) => derived.has(id)),
      ),
      privileges: (roleId) =>
        new Set(
          [...(derived.get(roleId)?.grants ?? [])]
            .filter(([, grant]) => grant.mask > 0)
            .map(([name]) => privilegeId(organizationId, name))
            .filter((id) => known.has(id)),
        ),
    };
  };
  // The principal a portal read runs as. Standard model: the existing application user, else the local one the site creates
  // on first use (server.mjs portalApplicationUser), which holds System Administrator; a read never creates it. An enhanced
  // visitor whose mapping failed reads as a principal without roles or profiles (every secured column null).
  const reader = (identity = {}) => {
    if (enhanced(identity)) return mappedUser(identity) ?? { systemuserid: null };
    const id = existingApplicationUser();
    return (id ? principals.byId(id) : SYSTEM_ADMINISTRATOR_STAND_IN) ?? { systemuserid: null };
  };
  const rowMasker = (identity = {}) => {
    if (!enhanced(identity)) return null;
    return (logical) => {
      const user = mappedUser(identity),
        fls = fieldSecurity();
      return user && fls?.rowMask ? fls.rowMask(user, logical) : null;
    };
  };

  return {
    describe,
    customAccessEnabled: () => describe().state === CUSTOM_ACCESS_ENABLED_STATE,
    /** The table permissions of `granted` that the mapped user's Dataverse privileges keep (data.mjs rules()). */
    filterRules(granted, entity, operation, identity = {}) {
      if (!enhanced(identity) || !granted.length || !RIGHT[operation]) return granted;
      const user = mappedUser(identity);
      // A /_sim read (identity.mappingPreview: the record counts of the session's visitor) never provisions: a visitor no portal
      // request has mapped yet is evaluated against the mapping prepare() would write, without writing it.
      // ponytail: a mapped visitor whose table permissions changed since its last portal request reads its last mapping.
      const preview =
        !user && identity.mappingPreview === true && !unusable.has(userIdOf(identity))
          ? previewMapping(identity)
          : null;
      if (!user && !preview) return [];
      const roles = webRoles(),
        holds = preview ? preview.roles : new Set(principals.roles(user).map((role) => key(role.roleid)));
      const privilege = privilegeId(organizationId, privilegeName(RIGHT[operation], noun(entity)));
      // ponytail: Dataverse-level checks (records.mjs) still name a custom activity's own privilege; only the portal
      // mapping uses the shared activity privileges.
      return granted.filter((rule) =>
        ruleRoles(rule, roles).some((roleId) => {
          const securityRole = securityRoleId(roleId);
          return (
            holds.has(securityRole) &&
            (preview ? preview.privileges(securityRole) : rolePrivileges(securityRole)).has(privilege)
          );
        }),
      );
    },
    /** null, or (logical) => row mask of the mapped user's field security profiles (data.mjs queryContext backendRowsMask). */
    rowMasker,
    /**
     * The row a portal read receives, through the same column security as a Dataverse Web API read by its caller
     * (dataverse-fls.mjs mask with the view of a single read without UnMaskedData): secured columns the caller cannot read
     * are null and readable ones answer their masking rule. The caller is the visitor's mapped user (enhanced model) or, for
     * a portal request in the standard model, the site's application user (Learn unify-pages-security-with-dataverse:
     * "Power Pages evaluates table and record permissions after data retrieval from Dataverse by using the Power Pages
     * application user"). A caller that cannot be resolved reads every secured column as null.
     * Every portal read routes here (data.mjs get, query and fetchXml with portalRequest): forms, lists, search, Liquid
     * fetchxml/entities and the portal Web API (Learn power-pages/security/column-security-profile: column security "applies to
     * all components and APIs used in Power Pages"). A portal read never sends UnMaskedData, and Learn
     * create-manage-masking-rules: "System and application users with Read and Read unmasked permissions get masked values by
     * default", so masking rules always apply. A standard-model site's own masking on Liquid fetchxml is not known. `fetch` ({ aliases, columns } of a FetchXML result) masks link-entity columns under their
     * alias prefix and attribute aliases by key; related rows nested under a relationship name ($expand) are masked by their
     * own table.
     */
    maskRow(identity, logical, row, { portalRequest = false, fetch = null } = {}) {
      const fls = fieldSecurity();
      if (!row || !fls?.mask || !(enhanced(identity) || portalRequest)) return row;
      const user = reader(identity);
      const view = { unmask: false, single: true };
      const mask = (name, value) => {
        const out = fls.mask(user, name, value, { view });
        const relationships = store.resolveMapping(name)?.relationships ?? {};
        for (const [navigation, rel] of Object.entries(relationships)) {
          const nested = out[navigation];
          if (nested && typeof nested === 'object' && rel?.entity)
            out[navigation] = Array.isArray(nested)
              ? nested.map((item) => (item && typeof item === 'object' ? mask(rel.entity, item) : item))
              : mask(rel.entity, nested);
        }
        return out;
      };
      let out = mask(logical, row);
      if (!fetch) return out;
      for (const [alias, linked] of Object.entries(fetch.aliases ?? {}))
        out = fls.mask(user, linked, out, { prefix: `${alias}.`, view });
      for (const column of fetch.columns ?? []) {
        // Aggregate values are computed, not column values; a groupby value is the column's.
        if (!column.aliased || column.aggregate != null || out[column.key] == null) continue;
        const value = fls.maskValue(user, column.entity, column.attribute, out[column.key], view);
        if (value === out[column.key]) continue;
        out[column.key] = value;
        for (const key of Object.keys(out)) if (key.startsWith(`${column.key}@`)) delete out[key];
      }
      return out;
    },
    /**
     * The operand rule of a portal read, as the reader maskRow uses: a $filter, $orderby, $expand option, $apply step, FetchXML
     * condition, order, aggregate or distinct over a column that principal reads masked is refused with the Dataverse error
     * (dataverse-records.mjs secureInternal, 400 0x80041155 CannotFilterOnMaskedAttribute; Learn create-manage-masking-rules
     * and web-service-error-codes). The portal-side status and body are a guess.
     */
    assertOperands(identity, logical, { portalRequest = false, fetchXml = null, params = null } = {}) {
      if (!(enhanced(identity) || portalRequest) || !fieldSecurity()?.maskedFor) return;
      store.recordPipeline?.secureInternal?.({ user: reader(identity) }, logical, { fetchXml, params });
    },
    /** Whether that reader reads one column masked (the assertOperands rule for a single column; list search/sort, native-services). */
    maskedColumn(identity, logical, column, { portalRequest = false } = {}) {
      if (!(enhanced(identity) || portalRequest)) return false;
      return Boolean(fieldSecurity()?.maskedFor?.(reader(identity), logical, column));
    },
    /** Whether a portal reader may restore or stream the bytes of a raw attachment column. */
    canReadRawColumn(identity, logical, column, recordId) {
      const fls = fieldSecurity();
      if (!fls) return true;
      const user = reader(identity);
      return (
        fls.canRead?.(user, logical, column, recordId) !== false &&
        fls.maskedFor?.(user, logical, column, undefined, recordId) !== true
      );
    },
    /** The portal the Web API column policy reads: without the column permission profiles in the enhanced model. */
    webApiPortal(source) {
      if (describe().model !== 'enhanced' || !source) return source;
      return {
        ...source,
        records: (source.records ?? []).filter((record) => !COLUMN_PERMISSION_KINDS.has(record.kind)),
      };
    },
    /** The write context fields of a portal write: {} (standard), else the mapped user called by the application user. */
    principal(identity = {}) {
      if (!enhanced(identity)) return {};
      const user = mappedUser(identity);
      if (!user)
        throw new DataError(
          'The visitor is not mapped to a Dataverse user for enhanced authorization.',
          403,
          'PermissionDenied',
        );
      return { user, caller: (applicationUserId && principals.byId(applicationUserId)) || user };
    },
    /** The systemuser row a portal read runs as (reader above); a read never creates the application user. */
    readerUser(identity = {}) {
      return reader(identity);
    },
    /** The site's host application user id when it exists (either model), else null; never creates it. */
    applicationUserId() {
      return applicationUserId ?? existingApplicationUser() ?? null;
    },
    /** The systemuser id server logic's InvokeCustomApi runs as in the enhanced model (impersonation), else null. */
    principalId(identity = {}) {
      return enhanced(identity) ? this.principal(identity).user.systemuserid : null;
    },
    prepare,
  };
}
