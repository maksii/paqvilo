/*
 * The Power Pages authorization bridge: one place every portal entry point reaches (data.mjs rules(), the row mask of
 * queryContext() and get(), the portal Web API column policy and write context, server logic's InvokeCustomApi principal).
 *
 * enhancedauthorization (powerpagesite table): 0 Disabled, 1 Migration in progress, 2 Migration Failed, 3 Enabled.
 * - standard model (0): table and record permissions are evaluated after retrieval from Dataverse, as the Power Pages
 *   application user. The store evaluates table permissions and the Web API column permissions.
 * - enhanced model: each contact maps to a system user per site and each web role to a security role holding the web
 *   role's permissions; Dataverse operations impersonate the site user, and Dataverse column security profiles replace the
 *   Web API column permissions (https://learn.microsoft.com/power-pages/security/unify-pages-security-with-dataverse).
 *   Column security applies to every Power Pages component and API, anonymous visitors included.
 *
 * Enhanced evaluation here: prepare() derives one security role per web role from the table permissions (privilege per
 * operation and table at the depth below) and one system user per contact and site (plus one anonymous user per site) holding
 * the security roles of the visitor's web roles. A table permission then grants only when the mapped user holds, through the
 * security role of one of the permission's web roles, the Dataverse privilege for the operation: an administrator who removes
 * the privilege from that role in Dataverse revokes the grant. Rows read are masked by the field security profiles of the
 * mapped user (dataverse-fls.mjs rowMask), and portal writes run as the mapped user, called by the site's application user
 * (impersonation), so the record pipeline's column security hooks apply to them.
 */
import { DataError } from "./data-error.mjs";
import { ACCESS_MODE, DEPTH, applyRoleGrants, removeRoleGrants, grantTablePrivileges, privilegeId, privilegeName, uuidV5 } from "./dataverse-security.mjs";
import { portalWebRoles } from "./permissions.mjs";
import { SYSTEM_ADMINISTRATOR_STAND_IN } from "./dataverse-fls.mjs";
import { ENHANCED_AUTHORIZATION_STATES } from "./platform-changes.mjs";

const key = (value) => String(value?.id ?? value ?? "").replace(/[{}]/g, "").toLowerCase();
const field = (record, name) => record?.[`adx_${name}`] ?? record?.[`mspp_${name}`] ?? record?.[name];
const RIGHT = { read: "Read", create: "Create", update: "Write", delete: "Delete", append: "Append", appendTo: "AppendTo" };
// The depth each scope gets is a guess (Learn says only that table permissions are "reflected" in the mapped security role):
// Global -> Global (organization), Account -> Local (business unit), Contact and Self -> Basic (user), Parent -> the
// depth of the permission it hangs from. The records a grant reaches stay those its scope selects in data.mjs allowed(): the
// closest documented statement is that Dataverse "returns only the records the user is allowed to access".
const SCOPE_DEPTH = { global: DEPTH.Global, account: DEPTH.Local, contact: DEPTH.Basic, self: DEPTH.Basic };
const COLUMN_PERMISSION_KINDS = new Set(["columnpermissionprofile", "columnpermission"]);

/**
 * The model a site record selects: { state, label, model: 'standard' | 'enhanced' }.
 * Learn lists the labels of states 1 (Migration in progress) and 2 (Migration Failed) without saying which model
 * serves the site meanwhile; every non-zero documented state runs the enhanced model here, as the ENHANCED_AUTHORIZATION finding
 * treats them. An undocumented value runs the standard model.
 */
export function portalAuthorizationModel(website) {
  const state = Number(field(website, "enhancedauthorization") ?? 0) || 0;
  const enhanced = Object.hasOwn(ENHANCED_AUTHORIZATION_STATES, state);
  // An undocumented value reads as the standard model; the host records PORTAL_AUTHORIZATION_STATE_UNKNOWN for it.
  const label = enhanced ? ENHANCED_AUTHORIZATION_STATES[state] : state === 0 ? "Disabled" : `Unknown (${state})`;
  return { state, label, model: enhanced ? "enhanced" : "standard", ...(enhanced || state === 0 ? {} : { unknown: true }) };
}

/**
 * The bridge for one site and organization. website(): the site record; principals, fieldSecurity(): the organization's
 * (dataverse-security createPrincipals, api.fieldSecurity); applicationUser(): async, the site's application user id (the
 * caller of impersonated writes); diagnostic(entry): records a runtime diagnostic.
 */
export function createPortalAuthorization({ store, website, portal, principals, fieldSecurity = () => null, organizationId, applicationUser = async () => null, existingApplicationUser = () => null, diagnostic = () => {} }) {
  const describe = () => portalAuthorizationModel(website());
  const enhanced = (identity) => !identity?.admin && describe().model === "enhanced";
  const siteId = () => key(field(website(), "websiteid") ?? field(website(), "powerpagesiteid") ?? website()?.id ?? "site");
  const webRoles = () => portalWebRoles(portal());
  const securityRoleId = (webRoleId) => uuidV5(organizationId, `portal-web-role:${siteId()}:${key(webRoleId)}`);
  const contactOf = (identity) => key(identity?.contactId ?? identity?.id) || null;
  // One site user per contact and site (Learn: "Multiple system user records can be created for a single contact")
  // and one per site for anonymous visitors (Learn column-security-profile: "Anonymous users represents all users accessing the
  // site without authentication"); the ids are local.
  const userIdOf = (identity) => uuidV5(organizationId, `portal-site-user:${siteId()}:${contactOf(identity) ?? "anonymous"}`);
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
  // The web roles a visitor holds: resolved ids, the web roles its names match and, for a local override persona, the
  // authenticated or anonymous web roles membership resolution would give it.
  const identityRoles = (identity, roles) => {
    const ids = new Set((identity.roleIds ?? []).map(key));
    const names = new Set(identity.roles ?? []);
    for (const role of roles) if (names.has(role.name)) ids.add(role.id);
    if (identity.roleSource !== "memberships")
      for (const role of roles) if (contactOf(identity) ? role.authenticated : role.anonymous) ids.add(role.id);
    return [...ids];
  };
  const noun = (logical) => principals.privilegeNoun(logical);

  // Security role id -> { name, grants: Map(privilege name -> { logical, mask, wildcard }) }, from the enabled table permissions.
  // A wildcard (*) permission expands to every mapped table that has privileges in the organization.
  function derivedRoles() {
    const roles = webRoles(), byId = new Map(roles.map((role) => [role.id, role]));
    const permissions = (store.state.permissions ?? []).filter((rule) => rule.enabled !== false && rule.entity);
    const everyTable = () => Object.keys(store.state.mappings ?? {}).filter((logical) => store.state.mappings[logical]?.dataverseOnly !== true);
    const byRule = new Map(permissions.map((rule) => [key(rule.id), rule]));
    const depthOf = (rule, seen = new Set()) => {
      if (rule.scope !== "parent") return SCOPE_DEPTH[rule.scope ?? "global"] ?? DEPTH.Basic;
      const parent = byRule.get(key(rule.parentPermissionId ?? rule.parentId));
      return parent && !seen.has(parent) ? depthOf(parent, seen.add(rule)) : DEPTH.Basic;
    };
    const out = new Map();
    for (const role of roles) out.set(securityRoleId(role.id), { name: role.name, grants: new Map() });
    for (const rule of permissions)
      for (const roleId of ruleRoles(rule, roles)) {
        if (!byId.has(roleId)) continue;
        const grants = out.get(securityRoleId(roleId)).grants, depth = depthOf(rule);
        for (const logical of rule.entity === "*" ? everyTable() : [rule.entity])
          for (const operation of rule.operations ?? ["read"]) {
            if (!RIGHT[operation]) continue;
            const name = privilegeName(RIGHT[operation], noun(logical));
            grants.set(name, { logical, wildcard: rule.entity === "*" && grants.get(name)?.wildcard !== false, mask: Math.max(grants.get(name)?.mask ?? 0, depth) });
          }
      }
    return out;
  }
  const signatureOf = (grants) => [...grants].map(([name, grant]) => `${name}:${grant.mask}`).sort().join("|");
  // The role's grants as stored in Dataverse, to see whether an administrator changed them since the last rewrite.
  const storedGrants = (roleId) => store.tableRows("roleprivileges").filter((row) => key(row.roleid) === roleId)
    .map((row) => `${key(row.privilegeid)}:${row.privilegedepthmask}`).sort().join("|");
  // Marks persisted per derived role: the permission signature it was written from and the grants written (older states: a string).
  const markOf = (mark) => (typeof mark === "string" ? { derived: mark, applied: null } : mark ?? null);

  // ponytail: prepare() recomputes the derived roles from every table permission on each portal request (O(permissions));
  // a permission revision counter on the store would let it skip unchanged requests.
  async function prepare(identity = {}) {
    if (!enhanced(identity)) return;
    try {
      applicationUserId ??= await applicationUser();
      const derived = derivedRoles(), userId = userIdOf(identity);
      const wanted = new Set(identityRoles(identity, webRoles()).map(securityRoleId).filter((id) => derived.has(id)));
      const marks = store.state.dataverse?.portalAuthorization?.roles ?? {};
      const linked = new Set(store.tableRows("systemuserroles").filter((row) => key(row.systemuserid) === userId).map((row) => key(row.roleid)));
      const stale = unusable.has(userId) || [...derived].some(([roleId, role]) => markOf(marks[roleId])?.derived !== signatureOf(role.grants) || !store.tableRows("role").some((row) => key(row.roleid) === roleId))
        || !store.tableRows("systemuser").some((row) => key(row.systemuserid) === userId)
        || [...derived.keys()].some((roleId) => linked.has(roleId) !== wanted.has(roleId))
        || Object.keys(marks).some((roleId) => !derived.has(roleId));
      if (stale) await store.transact(() => sync(derived, identity, userId, wanted));
      unusable.delete(userId);
    } catch (cause) {
      // Fail closed: until a sync succeeds every enhanced evaluation for this visitor denies, whatever links it still has.
      unusable.add(userIdOf(identity));
      diagnostic({ code: "PORTAL_AUTHORIZATION_SYNC_FAILED", severity: "error", model: "enhanced", message: `The enhanced authorization model could not map the visitor to Dataverse security: ${cause.message}` });
    }
  }

  function sync(derived, identity, userId, wanted) {
    const tables = store.state.tables;
    const businessUnit = (tables.businessunit ?? []).find((row) => !key(row.parentbusinessunitid));
    if (!businessUnit) throw new DataError("The organization has no root business unit.", 503, "OrganizationUnavailable");
    const ref = (logical, id, name = "") => ({ id, logical_name: logical, name });
    const bu = ref("businessunit", businessUnit.businessunitid, businessUnit.name ?? "");
    const org = ref("organization", organizationId);
    const known = new Set((tables.privilege ?? []).map((row) => key(row.privilegeid)));
    const marks = ((store.state.dataverse ??= {}).portalAuthorization ??= { roles: {} }).roles;
    // The derived roles mirror the current web roles: the role of a web role that is gone loses its grants and user links.
    for (const roleId of Object.keys(marks))
      if (!derived.has(roleId)) { removeRoleGrants(store, roleId); delete marks[roleId]; }
    for (const [roleId, role] of derived) {
      const roles = (tables.role ??= []);
      const existing = roles.find((row) => key(row.roleid) === roleId);
      if (existing) existing.name = role.name;
      else roles.push({ roleid: roleId, name: role.name, businessunitid: bu, organizationid: org, isinherited: 1 });
      const signature = signatureOf(role.grants), mark = markOf(marks[roleId]);
      if (mark?.derived === signature) continue;
      // Learn says the permissions defined in web roles "are reflected in these security roles" and that these
      // constructs are mapped "so that access can be enforced directly at Dataverse"; how the platform treats a manual change
      // to a mapped role is not documented. The role is platform-managed here: a table-permission change rewrites it, and a
      // manual change the rewrite overwrites is reported once.
      if (mark?.applied != null && storedGrants(roleId) !== mark.applied)
        diagnostic({ code: "PORTAL_AUTHORIZATION_ROLE_RESYNCED", severity: "warning", model: "enhanced", role: role.name, message: `The security role mapped to web role '${role.name}' was changed in Dataverse; the table permissions changed and rewrote it, which replaced that change.` });
      const grants = [];
      for (const [name, { logical, mask, wildcard }] of role.grants) {
        const id = privilegeId(organizationId, name);
        // A table mapped after the security seed gets its standard privileges first; an unknown table is reported below.
        if (!known.has(id))
          try { for (const added of grantTablePrivileges(store, organizationId, logical)) known.add(privilegeId(organizationId, added)); } catch { /* reported below */ }
        if (known.has(id)) grants.push({ privilegeid: id, mask });
        else if (!wildcard) diagnostic({ code: "PORTAL_AUTHORIZATION_PRIVILEGE_UNKNOWN", severity: "warning", privilege: name, role: role.name, message: `Web role '${role.name}' grants ${name}, which the organization does not define; the grant is not mapped.` });
      }
      applyRoleGrants(store, roleId, grants);
      marks[roleId] = { derived: signature, applied: storedGrants(roleId) };
    }
    const users = (tables.systemuser ??= []);
    const name = String(identity.fullname || identity.name || (contactOf(identity) ? contactOf(identity) : "Anonymous users"));
    // Learn says these users "are managed internally, don't provide direct access to Dataverse"; systemmanagedusertype
    // 1 (C2 User, systemuser table reference) and the non-interactive access mode are the closest documented values.
    const user = users.find((row) => key(row.systemuserid) === userId);
    if (user) user.fullname = name;
    else users.push({ systemuserid: userId, fullname: name, systemmanagedusertype: 1, accessmode: ACCESS_MODE.NonInteractive, isdisabled: false, businessunitid: bu, organizationid: org });
    const links = (tables.systemuserroles ??= []);
    for (let index = links.length - 1; index >= 0; index--)
      if (key(links[index].systemuserid) === userId && derived.has(key(links[index].roleid)) && !wanted.has(key(links[index].roleid))) links.splice(index, 1);
    for (const roleId of wanted)
      if (!links.some((row) => key(row.systemuserid) === userId && key(row.roleid) === roleId))
        links.push({ systemuserroleid: uuidV5(userId, roleId), systemuserid: ref("systemuser", userId, name), roleid: ref("role", roleId, derived.get(roleId).name) });
  }

  // Security role id -> Set(privilege id) of its grants, rebuilt when roleprivileges change.
  let held = { revision: null, map: new Map() };
  const rolePrivileges = (roleId) => {
    const revision = store.tablesRevision?.(["roleprivileges"]) ?? store.dataRevision();
    if (held.revision !== revision) {
      const map = new Map();
      for (const row of store.tableRows("roleprivileges")) {
        if (!(Number(row.privilegedepthmask) > 0)) continue;
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
    const derived = derivedRoles(), known = new Set(store.tableRows("privilege").map((row) => key(row.privilegeid)));
    return { roles: new Set(identityRoles(identity, webRoles()).map(securityRoleId).filter((id) => derived.has(id))),
      privileges: (roleId) => new Set([...(derived.get(roleId)?.grants ?? [])].filter(([, grant]) => grant.mask > 0)
        .map(([name]) => privilegeId(organizationId, name)).filter((id) => known.has(id))) };
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
      const user = mappedUser(identity), fls = fieldSecurity();
      return user && fls?.rowMask ? fls.rowMask(user, logical) : null;
    };
  };

  return {
    describe,
    /** The table permissions of `granted` that the mapped user's Dataverse privileges keep (data.mjs rules()). */
    filterRules(granted, entity, operation, identity = {}) {
      if (!enhanced(identity) || !granted.length || !RIGHT[operation]) return granted;
      const user = mappedUser(identity);
      // A /_sim read (identity.mappingPreview: the record counts of the session's visitor) never provisions: a visitor no portal
      // request has mapped yet is evaluated against the mapping prepare() would write, without writing it.
      // ponytail: a mapped visitor whose table permissions changed since its last portal request reads its last mapping.
      const preview = !user && identity.mappingPreview === true && !unusable.has(userIdOf(identity)) ? previewMapping(identity) : null;
      if (!user && !preview) return [];
      const roles = webRoles(), holds = preview ? preview.roles : new Set(principals.roles(user).map((role) => key(role.roleid)));
      const privilege = privilegeId(organizationId, privilegeName(RIGHT[operation], noun(entity)));
      return granted.filter((rule) => ruleRoles(rule, roles).some((roleId) => {
        const securityRole = securityRoleId(roleId);
        return holds.has(securityRole) && (preview ? preview.privileges(securityRole) : rolePrivileges(securityRole)).has(privilege);
      }));
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
        let out = fls.mask(user, name, value, { view });
        const relationships = store.resolveMapping(name)?.relationships ?? {};
        for (const [navigation, rel] of Object.entries(relationships)) {
          const nested = out[navigation];
          if (nested && typeof nested === "object" && rel?.entity)
            out[navigation] = Array.isArray(nested) ? nested.map((item) => (item && typeof item === "object" ? mask(rel.entity, item) : item)) : mask(rel.entity, nested);
        }
        return out;
      };
      let out = mask(logical, row);
      if (!fetch) return out;
      for (const [alias, linked] of Object.entries(fetch.aliases ?? {})) out = fls.mask(user, linked, out, { prefix: `${alias}.`, view });
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
    /** The portal the Web API column policy reads: without the column permission profiles in the enhanced model. */
    webApiPortal(source) {
      if (describe().model !== "enhanced" || !source) return source;
      return { ...source, records: (source.records ?? []).filter((record) => !COLUMN_PERMISSION_KINDS.has(record.kind)) };
    },
    /** The write context fields of a portal write: {} (standard), else the mapped user called by the application user. */
    principal(identity = {}) {
      if (!enhanced(identity)) return {};
      const user = mappedUser(identity);
      if (!user) throw new DataError("The visitor is not mapped to a Dataverse user for enhanced authorization.", 403, "PermissionDenied");
      return { user, caller: (applicationUserId && principals.byId(applicationUserId)) || user };
    },
    /** The systemuser id server logic's InvokeCustomApi runs as in the enhanced model (impersonation), else null. */
    principalId(identity = {}) {
      return enhanced(identity) ? this.principal(identity).user.systemuserid : null;
    },
    prepare,
  };
}
