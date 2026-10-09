import { portalField as field, normalizePortalPath } from "./importer.mjs";
const normalize = (value) =>
  String(
    typeof value === "object"
      ? (value?.id ?? value?.adx_webroleid ?? value?.mspp_webroleid ?? "")
      : (value ?? ""),
  )
    .replace(/[{}]/g, "")
    .toLowerCase();
const flag = (value) =>
  value === true ||
  value === 1 ||
  (typeof value === "string" && value.toLowerCase() === "true");
const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const SERVICE_MARKERS = ["Access Denied", "Page Not Found"];

/**
 * Read access to an exported page or web file for a persona
 * (docs/platform-internals-reference.md 2.1-2.3; Microsoft page-security docs):
 * - Service pages (Access Denied / Page Not Found site markers) are always readable.
 * - Content in a non-visible publishing state (or an unpublished website language)
 *   is readable only with Preview Unpublished Entities website access.
 * - Web files outside their release/expiration window are not readable.
 * - Rules of the page and all ancestors apply; a web file uses only its direct parent
 *   page's rules and ignores rules with scope 2 (exclude direct child web files).
 * - A role on a Grant Change rule grants full access; every Restrict Read page needs
 *   one of its roles. Anonymous visitors have no page roles (the Anonymous Users role
 *   "respects only table permissions"); signed-in visitors get Authenticated Users roles.
 * `options.previewCookie === false` disables preview for a permitted persona
 * (the platform auto-enables the preview cookie for permitted users).
 */
export function pageAccess(portal, target, identity = {}, { previewCookie, now = Date.now() } = {}) {
  identity ??= {};
  const page =
    typeof target === "string"
      ? portal.pages.find(
          (p) =>
            p.id === target ||
            normalizePortalPath(p.url) === normalizePortalPath(target),
        )
      : target;
  const asset = target?.file ? target : null;
  const pageId = asset
    ? normalize(field(asset.metadata, "parentpageid"))
    : page?.id;
  // A web file without a parent page is served at its own partial URL and has no page
  // rules; its own publishing state and release dates still apply.
  if (!pageId && !asset)
    return {
      allowed: false,
      status: 403,
      code: "PAGE_IDENTITY_UNRESOLVED",
      diagnostics: [
        {
          code: "PAGE_IDENTITY_UNRESOLVED",
          message: "A page or web file parent is required",
        },
      ],
    };
  const ancestors = [];
  let current = pageId ? portal.pages.find((p) => p.id === pageId) : null;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    ancestors.push(current.id);
    current = portal.pages.find((p) => p.id === current.parentId);
  }
  if (pageId && (current || !ancestors.length))
    return {
      allowed: false,
      status: 403,
      code: "PAGE_HIERARCHY_UNRESOLVED",
      diagnostics: [
        {
          code: "PAGE_HIERARCHY_UNRESOLVED",
          message: "Cannot evaluate page inheritance",
        },
      ],
    };
  const roleRecords = portal.records.filter(
    (r) => r.kind === "webrole" && Number(field(r, "statecode", 0)) !== 1,
  );
  const roles = new Map(roleRecords.map((r) => [normalize(r.id), r.name]));
  const authenticated = Boolean(
    identity?.id ?? identity?.contactId ?? identity?.authenticated,
  );
  const memberships = identity.roleSource === "memberships";
  const provided = new Set();
  if (authenticated) {
    for (const r of [...(identity?.roles ?? []), ...(identity?.roleIds ?? [])])
      provided.add(typeof r === "object" ? (r.name ?? normalize(r)) : String(r));
    if (!memberships)
      for (const r of roleRecords)
        if (flag(field(r, "authenticatedusersrole", false))) {
          provided.add(r.name);
          provided.add(normalize(r.id));
        }
  }
  const membershipIds = new Set((identity.roleIds ?? []).map(normalize));
  const hasRole = (roleId) =>
    authenticated &&
    (memberships
      ? membershipIds.has(roleId)
      : provided.has(roleId) || provided.has(roles.get(roleId)));
  const diagnostics = [];
  const anonymousRoles = new Set(
    roleRecords.filter((r) => flag(field(r, "anonymoususersrole", false))).map((r) => normalize(r.id)),
  );
  // Service pages are always readable.
  const servicePageIds = new Set(
    (portal.siteMarkers ?? [])
      .filter((marker) => SERVICE_MARKERS.includes(marker.name))
      .map((marker) => marker.pageId),
  );
  if (!asset && servicePageIds.has(page.id))
    return { allowed: true, status: 200, reason: "service-page", diagnostics };
  // Preview Unpublished Entities website access (role-based; anonymous has no roles).
  const canPreview =
    previewCookie !== false &&
    (portal.websiteAccess ?? []).some(
      (access) => access.previewUnpublishedEntities && access.roleIds.some((roleId) => roles.has(roleId) && hasRole(roleId)),
    );
  if (portal.language && portal.language.published === false && !canPreview)
    return {
      allowed: false,
      status: 404,
      code: "LANGUAGE_UNPUBLISHED",
      diagnostics: [
        ...diagnostics,
        { code: "LANGUAGE_UNPUBLISHED", message: `The ${portal.language.name ?? "selected"} website language is not in a visible publishing state.` },
      ],
    };
  const subject = asset ?? page;
  const stateId = normalize(field(subject.metadata ?? subject, "publishingstateid"));
  if (stateId) {
    const state = (portal.publishingStates ?? []).find((s) => s.id === stateId);
    if (!state && portal.publishingStates)
      diagnostics.push({
        code: "PUBLISHING_STATE_UNRESOLVED",
        publishingStateId: stateId,
        message: "The referenced publishing state is not exported; the content is treated as visible.",
      });
    else if (state && !state.isVisible && !canPreview)
      return {
        allowed: false,
        status: 403,
        code: "PAGE_UNPUBLISHED",
        diagnostics: [
          ...diagnostics,
          { code: "PAGE_UNPUBLISHED", publishingStateId: stateId, message: `The ${asset ? "web file" : "page"} is in the non-visible publishing state '${state.name}'.` },
        ],
      };
  }
  // Release/expiration dates still apply to web files (no longer to pages).
  if (asset && !canPreview) {
    const release = Date.parse(field(asset.metadata, "releasedate") ?? ""),
      expiration = Date.parse(field(asset.metadata, "expirationdate") ?? "");
    if ((Number.isFinite(release) && now < release) || (Number.isFinite(expiration) && now > expiration))
      return {
        allowed: false,
        status: 403,
        code: "WEB_FILE_NOT_RELEASED",
        diagnostics: [...diagnostics, { code: "WEB_FILE_NOT_RELEASED", message: "The web file is outside its release/expiration dates." }],
      };
  }
  const scopePages = asset ? (pageId ? [pageId] : []) : ancestors;
  if (asset && !pageId)
    diagnostics.push({ code: "PAGE_FILE_WITHOUT_PARENT", message: "The web file has no parent page; no page access rules apply to it." });
  const rules = [];
  for (const record of portal.records.filter(
    (r) =>
      r.kind === "webpageaccesscontrolrule" &&
      Number(field(r, "statecode", 0)) !== 1,
  )) {
    const root = normalize(field(record, "webpageid"));
    if (!scopePages.includes(root)) {
      if (asset && ancestors.includes(root) && Number(field(record, "right")) === 2)
        diagnostics.push({
          code: "PAGE_FILE_ANCESTOR_RULE_IGNORED",
          ruleId: record.id,
          pageId: root,
          message: "Web files use only their direct parent page's rules; this ancestor restriction does not apply to the file.",
        });
      continue;
    }
    // Power Pages uses 1 for All content (the default) and 2 to exclude
    // directly related child web files from security validation.
    const scope = Number(field(record, "scope", 1));
    if (asset && scope === 2) continue;
    const right = Number(field(record, "right"));
    const associated = field(
      record,
      "webpageaccesscontrolrule_webrole",
      record.adx_webpageaccesscontrolrule_webrole ?? [],
    );
    const roleIds = list(associated).map(normalize).filter(Boolean);
    const knownRoleIds = roleIds.filter((id) => roles.has(id));
    const missingRoleIds = roleIds.filter((id) => !roles.has(id));
    const unresolved =
      ![1, 2].includes(scope) ||
      ![1, 2].includes(right) ||
      !knownRoleIds.length;
    if (unresolved)
      diagnostics.push({
        code: "PAGE_RULE_UNRESOLVED",
        ruleId: record.id,
        pageId: root,
        message:
          "Rule scope, right or associated role is missing from the export",
      });
    else if (missingRoleIds.length)
      diagnostics.push({
        code: "PAGE_ROLE_ASSOCIATIONS_UNRESOLVED",
        ruleId: record.id,
        pageId: root,
        roleIds: missingRoleIds,
        message:
          "Unresolved role associations grant no access; other resolved roles retain their exported grant.",
      });
    if (knownRoleIds.some((id) => anonymousRoles.has(id)))
      diagnostics.push({
        code: "PAGE_RULE_ANONYMOUS_ROLE_IGNORED",
        ruleId: record.id,
        pageId: root,
        message: "The Anonymous Users role respects only table permissions; it grants no page access.",
      });
    rules.push({
      id: record.id,
      root,
      right,
      unresolved,
      publishingStates: list(field(record, "accesscontrolrule_publishingstate", [])).map(normalize).filter(Boolean),
      matches: knownRoleIds.some(hasRole),
    });
  }
  // Grant Change rules tied to the content's publishing state take precedence.
  const grants = rules.filter((r) => r.right === 1 && !r.unresolved);
  const stateGrants = stateId ? grants.filter((r) => r.publishingStates.includes(stateId)) : [];
  if ((stateGrants.length ? stateGrants : grants.filter((r) => !r.publishingStates.length)).some((r) => r.matches))
    return { allowed: true, status: 200, reason: "grant-change", diagnostics };
  for (const root of scopePages) {
    const restrictions = rules.filter((r) => r.root === root && r.right === 2);
    if (
      restrictions.length &&
      !restrictions.some((r) => !r.unresolved && r.matches)
    )
      return {
        allowed: false,
        status: 403,
        code: restrictions.some((r) => r.unresolved)
          ? "PAGE_RULE_UNRESOLVED"
          : "PAGE_ACCESS_DENIED",
        ruleIds: restrictions.map((r) => r.id),
        diagnostics,
      };
  }
  if (rules.some((r) => r.unresolved && r.right !== 1))
    return {
      allowed: false,
      status: 403,
      code: "PAGE_RULE_UNRESOLVED",
      diagnostics,
    };
  return { allowed: true, status: 200, reason: "public-or-role", diagnostics };
}

export const checkPageAccess = pageAccess;

/**
 * Read access to a shortcut (navigation only; shortcuts have no URL of their own):
 * with "Disable Target Validation" the parent page decides, otherwise the target page
 * or web file; an external URL target is readable when target validation applies.
 */
export function shortcutAccess(portal, shortcut, identity = {}, options) {
  const parent = portal.pages.find((page) => page.id === shortcut.parentId);
  if (flag(shortcut.disableTargetValidation))
    return parent
      ? pageAccess(portal, parent, identity, options)
      : { allowed: false, status: 403, code: "SHORTCUT_PARENT_UNRESOLVED", diagnostics: [] };
  const page = shortcut.targetPageId && portal.pages.find((item) => item.id === shortcut.targetPageId);
  if (page) return pageAccess(portal, page, identity, options);
  const file = shortcut.targetFileId && (portal.webFiles ?? []).find((item) => item.id === shortcut.targetFileId);
  if (file) return pageAccess(portal, file, identity, options);
  if (shortcut.url && !shortcut.targetPageId && !shortcut.targetFileId)
    return { allowed: true, status: 200, reason: "external-url", diagnostics: [] };
  return { allowed: false, status: 403, code: "SHORTCUT_TARGET_UNRESOLVED", diagnostics: [] };
}
