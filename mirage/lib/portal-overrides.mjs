import { bindSiteSettings, effectiveEnvironmentVariables } from './secret-resolver.mjs';

const safeName = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 512 &&
  !['__proto__', 'prototype', 'constructor'].includes(name) &&
  // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
  !/[\u0000-\u001f\u007f]/.test(name);
const truth = (value) => value === true || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true');
const invalid = (message) => Object.assign(new Error(message), { status: 400, code: 'InvalidPortalOverride' });

function validateAccessRule(content) {
  // Page access control rules: right 1 = grant change, 2 = restrict read; scope 1 = all content, 2 = exclude direct child web files.
  if (
    !content ||
    typeof content !== 'object' ||
    Array.isArray(content) ||
    Object.keys(content).some((key) => !['name', 'webPageId', 'right', 'scope', 'roleIds'].includes(key))
  )
    throw invalid('Page access rules support name, webPageId, right, scope and roleIds.');
  if (!safeName(content.name) || !safeName(content.webPageId))
    throw invalid('Page access rules require a name and webPageId.');
  if (![1, 2].includes(content.right) || ![1, 2].includes(content.scope ?? 1))
    throw invalid('Page access rule right and scope must be 1 or 2.');
  if (!Array.isArray(content.roleIds) || !content.roleIds.length || content.roleIds.some((roleId) => !safeName(roleId)))
    throw invalid('Page access rules require at least one web-role ID.');
}

function validateRole(content) {
  if (
    !content ||
    typeof content !== 'object' ||
    Array.isArray(content) ||
    !safeName(content.name) ||
    Object.keys(content).some((key) => !['name', 'authenticatedUsersRole', 'anonymousUsersRole'].includes(key))
  )
    throw invalid('Web roles require a name and optional automatic-membership flags.');
  for (const key of ['authenticatedUsersRole', 'anonymousUsersRole'])
    if (content[key] !== undefined && typeof content[key] !== 'boolean')
      throw invalid('Web role flags must be boolean.');
}

function validateOverrideEntry(section, name, content) {
  if (!safeName(name)) throw invalid('Portal values require a valid name.');
  if (section === 'accessRules' && content !== null) validateAccessRule(content);
  else if (section === 'roles' && content !== null) validateRole(content);
  else if (content !== null && typeof content !== 'string')
    throw invalid('Portal values require a string or null value.');
}

/** Persisted local experiments overlay the exported source without rewriting it. */
export function validatePortalOverrides(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Portal overrides must be an object.');
  for (const [section, entries] of Object.entries(value)) {
    if (
      !['settings', 'snippets', 'roles', 'accessRules'].includes(section) ||
      !entries ||
      typeof entries !== 'object' ||
      Array.isArray(entries)
    )
      throw invalid('Portal overrides support settings, snippets, roles and accessRules objects.');
    for (const [name, content] of Object.entries(entries)) validateOverrideEntry(section, name, content);
  }
  return value;
}

/**
 * Site settings bound to environment variables (importer `settingEnvironmentVariables`) take the effective value of
 * `state`; a Secret binding resolves through `resolver` as `principalId` and stays unset otherwise. Returns the source
 * with those settings, so applyPortalOverrides still lets portalOverrides.settings win. The bound source feeds rendering
 * only: /_sim site-setting entries read the unbound source, and page inspection redacts every name in the explicit
 * `secretSettingNames` list (carried through applyPortalOverrides), so a resolved secret never reaches /_sim payloads.
 */
export async function bindPortalEnvironment(
  source,
  state,
  { resolver = null, principalId = null, diagnostic = () => {} } = {},
) {
  const bindings = source?.settingEnvironmentVariables;
  if (!bindings || !Object.keys(bindings).length) return source;
  const { settings, secretNames } = await bindSiteSettings(
    source.settings ?? {},
    bindings,
    effectiveEnvironmentVariables(state),
    { resolver, principalId, diagnostic },
  );
  return { ...source, settings, secretSettingNames: [...secretNames] };
}

function applyObjectOverrides(portal, source, overrides) {
  for (const section of ['settings', 'snippets']) {
    portal[section] = { ...source[section] };
    for (const [name, value] of Object.entries(overrides[section] ?? {})) {
      if (value === null) delete portal[section][name];
      else
        Object.defineProperty(portal[section], name, { value, enumerable: true, writable: true, configurable: true });
    }
  }
}

function applySnippetTranslations(portal, source, overrides) {
  if (!source.snippetTranslations) return;
  portal.snippetTranslations = Object.fromEntries(
    Object.entries(source.snippetTranslations).map(([language, values]) => {
      const copy = { ...values };
      for (const [name, value] of Object.entries(overrides.snippets ?? {})) {
        if (value === null) delete copy[name];
        else copy[name] = value;
      }
      return [language, copy];
    }),
  );
}

function applyRecordOverrides(portal, overrides, section, kind, buildRecord) {
  for (const [id, value] of Object.entries(overrides[section] ?? {})) {
    const index = portal.records.findIndex((record) => record.kind === kind && record.id === id);
    if (value === null) {
      if (index >= 0) portal.records.splice(index, 1);
      continue;
    }
    const previous = index >= 0 ? portal.records[index] : {};
    const record = buildRecord(id, value, previous);
    if (index >= 0) portal.records[index] = record;
    else portal.records.push(record);
  }
}

function applyRoleOverrides(portal, overrides) {
  applyRecordOverrides(portal, overrides, 'roles', 'webrole', (roleId, value, previous) => ({
    ...previous,
    kind: 'webrole',
    id: roleId,
    name: value.name,
    adx_webroleid: roleId,
    adx_name: value.name,
    adx_authenticatedusersrole: value.authenticatedUsersRole ?? false,
    adx_anonymoususersrole: value.anonymousUsersRole ?? false,
  }));
}

function applyAccessRuleOverrides(portal, overrides) {
  applyRecordOverrides(portal, overrides, 'accessRules', 'webpageaccesscontrolrule', (ruleId, value, previous) => ({
    _file: previous._file,
    kind: 'webpageaccesscontrolrule',
    id: ruleId,
    name: value.name,
    adx_webpageaccesscontrolruleid: ruleId,
    adx_name: value.name,
    adx_webpageid: value.webPageId,
    adx_right: value.right,
    adx_scope: value.scope ?? 1,
    adx_webpageaccesscontrolrule_webrole: [...value.roleIds],
    _localOverride: true,
  }));
}

export function applyPortalOverrides(source, overrides = {}) {
  validatePortalOverrides(overrides);
  const portal = { ...source, secretSettingNames: [...(source.secretSettingNames ?? [])] };
  applyObjectOverrides(portal, source, overrides);
  // A name-level override intentionally applies to every request language in
  // this instance. Otherwise a localized value would silently win over it.
  applySnippetTranslations(portal, source, overrides);
  portal.records = [...(source.records ?? [])];
  applyRoleOverrides(portal, overrides);
  applyAccessRuleOverrides(portal, overrides);
  return portal;
}

export function portalOverrideEntries(source, overrides = {}, section) {
  const effective = applyPortalOverrides(source, overrides);
  if (section === 'accessRules') {
    const idOf = (value) =>
      String(
        typeof value === 'object' && value
          ? (value.id ?? value.adx_webroleid ?? value.mspp_webroleid ?? '')
          : (value ?? ''),
      )
        .replace(/[{}]/g, '')
        .toLowerCase();
    const ruleValue = (record) => {
      if (!record) return null;
      const roles =
        record.adx_webpageaccesscontrolrule_webrole ??
        record.mspp_webpageaccesscontrolrule_webrole ??
        record.webpageaccesscontrolrule_webrole ??
        [];
      return {
        name: record.name,
        webPageId: idOf(record.adx_webpageid ?? record.mspp_webpageid ?? record.webpageid),
        right: Number(record.adx_right ?? record.mspp_right ?? record.right),
        scope: Number(record.adx_scope ?? record.mspp_scope ?? record.scope ?? 1),
        roleIds: (Array.isArray(roles) ? roles : [roles]).map(idOf).filter(Boolean),
      };
    };
    const records = (source.records ?? []).filter((record) => record.kind === 'webpageaccesscontrolrule');
    const find = (rows, id) => rows.find((record) => record.kind === 'webpageaccesscontrolrule' && record.id === id);
    return [...new Set([...records.map((record) => record.id), ...Object.keys(overrides.accessRules ?? {})])]
      .sort((a, b) => Number(a > b) - Number(a < b))
      .map((id) => ({
        id,
        name: find(effective.records, id)?.name ?? find(records, id)?.name ?? id,
        value: ruleValue(find(effective.records, id)),
        sourceValue: ruleValue(find(records, id)),
        sourceFile: find(records, id)?._file ?? null,
        overridden: Object.hasOwn(overrides.accessRules ?? {}, id),
        deleted: !find(effective.records, id),
      }));
  }
  if (section === 'roles') {
    const roleValue = (record) =>
      record && {
        name: record.name,
        authenticatedUsersRole: truth(
          record.adx_authenticatedusersrole ?? record.mspp_authenticatedusersrole ?? record.authenticatedusersrole,
        ),
        anonymousUsersRole: truth(
          record.adx_anonymoususersrole ?? record.mspp_anonymoususersrole ?? record.anonymoususersrole,
        ),
      };
    const records = (source.records ?? []).filter((record) => record.kind === 'webrole');
    return [...new Set([...records.map((record) => record.id), ...Object.keys(overrides.roles ?? {})])]
      .sort((a, b) => Number(a > b) - Number(a < b))
      .map((id) => ({
        id,
        name:
          effective.records.find((record) => record.kind === 'webrole' && record.id === id)?.name ??
          records.find((record) => record.id === id)?.name ??
          id,
        value: roleValue(effective.records.find((record) => record.kind === 'webrole' && record.id === id)) ?? null,
        sourceValue: roleValue(records.find((record) => record.id === id)) ?? null,
        overridden: Object.hasOwn(overrides.roles ?? {}, id),
        deleted: !effective.records.some((record) => record.kind === 'webrole' && record.id === id),
      }));
  }
  return [...new Set([...Object.keys(source[section] ?? {}), ...Object.keys(overrides[section] ?? {})])]
    .sort((a, b) => Number(a > b) - Number(a < b))
    .map((name) => ({
      id: name,
      name,
      value: effective[section][name] ?? null,
      sourceValue: source[section]?.[name] ?? null,
      overridden: Object.hasOwn(overrides[section] ?? {}, name),
      deleted: !Object.hasOwn(effective[section], name),
    }));
}
