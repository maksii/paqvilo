const safeName = (name) => typeof name === 'string' && name.length > 0 && name.length <= 512 && !['__proto__', 'prototype', 'constructor'].includes(name) && !/[\u0000-\u001f\u007f]/.test(name);
const truth = value => value === true || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true');
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'InvalidPortalOverride' });

/** Persisted local experiments overlay the exported source without rewriting it. */
export function validatePortalOverrides(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Portal overrides must be an object.');
  for (const [section, entries] of Object.entries(value)) {
    if (!['settings', 'snippets', 'roles', 'accessRules'].includes(section) || !entries || typeof entries !== 'object' || Array.isArray(entries)) throw invalid('Portal overrides support settings, snippets, roles and accessRules objects.');
    for (const [name, content] of Object.entries(entries)) {
      if (!safeName(name)) throw invalid('Portal values require a valid name.');
      if (section === 'accessRules' && content !== null) {
        // Page access control rules: right 1 = grant change, 2 = restrict read; scope 1 = all content, 2 = exclude direct child web files.
        if (!content || typeof content !== 'object' || Array.isArray(content) || Object.keys(content).some(key => !['name', 'webPageId', 'right', 'scope', 'roleIds'].includes(key))) throw invalid('Page access rules support name, webPageId, right, scope and roleIds.');
        if (!safeName(content.name) || !safeName(content.webPageId)) throw invalid('Page access rules require a name and webPageId.');
        if (![1, 2].includes(content.right) || ![1, 2].includes(content.scope ?? 1)) throw invalid('Page access rule right and scope must be 1 or 2.');
        if (!Array.isArray(content.roleIds) || !content.roleIds.length || content.roleIds.some(roleId => !safeName(roleId))) throw invalid('Page access rules require at least one web-role ID.');
      } else if (section === 'roles' && content !== null) {
        if (!content || typeof content !== 'object' || Array.isArray(content) || !safeName(content.name) || Object.keys(content).some(key => !['name', 'authenticatedUsersRole', 'anonymousUsersRole'].includes(key))) throw invalid('Web roles require a name and optional automatic-membership flags.');
        for (const key of ['authenticatedUsersRole', 'anonymousUsersRole']) if (content[key] !== undefined && typeof content[key] !== 'boolean') throw invalid('Web role flags must be boolean.');
      } else if (content !== null && typeof content !== 'string') throw invalid('Portal values require a string or null value.');
    }
  }
  return value;
}

export function applyPortalOverrides(source, overrides = {}) {
  validatePortalOverrides(overrides);
  const portal = { ...source };
  for (const section of ['settings', 'snippets']) {
    portal[section] = { ...source[section] };
    for (const [name, value] of Object.entries(overrides[section] ?? {})) {
      if (value === null) delete portal[section][name];
      else Object.defineProperty(portal[section], name, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  portal.records = [...source.records ?? []];
  for (const [roleId, value] of Object.entries(overrides.roles ?? {})) {
    const index = portal.records.findIndex(record => record.kind === 'webrole' && record.id === roleId);
    if (value === null) { if (index >= 0) portal.records.splice(index, 1); continue; }
    const record = { ...(index >= 0 ? portal.records[index] : {}), kind: 'webrole', id: roleId, name: value.name,
      adx_webroleid: roleId, adx_name: value.name, adx_authenticatedusersrole: value.authenticatedUsersRole ?? false, adx_anonymoususersrole: value.anonymousUsersRole ?? false };
    if (index >= 0) portal.records[index] = record; else portal.records.push(record);
  }
  for (const [ruleId, value] of Object.entries(overrides.accessRules ?? {})) {
    const index = portal.records.findIndex(record => record.kind === 'webpageaccesscontrolrule' && record.id === ruleId);
    if (value === null) { if (index >= 0) portal.records.splice(index, 1); continue; }
    const previous = index >= 0 ? portal.records[index] : {};
    const record = { _file: previous._file, kind: 'webpageaccesscontrolrule', id: ruleId, name: value.name, adx_webpageaccesscontrolruleid: ruleId, adx_name: value.name,
      adx_webpageid: value.webPageId, adx_right: value.right, adx_scope: value.scope ?? 1, adx_webpageaccesscontrolrule_webrole: [...value.roleIds], _localOverride: true };
    if (index >= 0) portal.records[index] = record; else portal.records.push(record);
  }
  return portal;
}

export function portalOverrideEntries(source, overrides = {}, section) {
  const effective = applyPortalOverrides(source, overrides);
  if (section === 'accessRules') {
    const idOf = value => String(typeof value === 'object' && value ? value.id ?? value.adx_webroleid ?? value.mspp_webroleid ?? '' : value ?? '').replace(/[{}]/g, '').toLowerCase();
    const ruleValue = record => {
      if (!record) return null;
      const roles = record.adx_webpageaccesscontrolrule_webrole ?? record.mspp_webpageaccesscontrolrule_webrole ?? record.webpageaccesscontrolrule_webrole ?? [];
      return { name: record.name, webPageId: idOf(record.adx_webpageid ?? record.mspp_webpageid ?? record.webpageid), right: Number(record.adx_right ?? record.mspp_right ?? record.right),
        scope: Number(record.adx_scope ?? record.mspp_scope ?? record.scope ?? 1), roleIds: (Array.isArray(roles) ? roles : [roles]).map(idOf).filter(Boolean) };
    };
    const records = (source.records ?? []).filter(record => record.kind === 'webpageaccesscontrolrule');
    const find = (rows, id) => rows.find(record => record.kind === 'webpageaccesscontrolrule' && record.id === id);
    return [...new Set([...records.map(record => record.id), ...Object.keys(overrides.accessRules ?? {})])].sort().map(id => ({
      id, name: find(effective.records, id)?.name ?? find(records, id)?.name ?? id,
      value: ruleValue(find(effective.records, id)), sourceValue: ruleValue(find(records, id)),
      sourceFile: find(records, id)?._file ?? null,
      overridden: Object.hasOwn(overrides.accessRules ?? {}, id), deleted: !find(effective.records, id),
    }));
  }
  if (section === 'roles') {
    const roleValue = record => record && ({ name: record.name, authenticatedUsersRole: truth(record.adx_authenticatedusersrole ?? record.mspp_authenticatedusersrole ?? record.authenticatedusersrole), anonymousUsersRole: truth(record.adx_anonymoususersrole ?? record.mspp_anonymoususersrole ?? record.anonymoususersrole) });
    const records = (source.records ?? []).filter(record => record.kind === 'webrole');
    return [...new Set([...records.map(record => record.id), ...Object.keys(overrides.roles ?? {})])].sort().map(id => ({
      id, name: effective.records.find(record => record.kind === 'webrole' && record.id === id)?.name ?? records.find(record => record.id === id)?.name ?? id,
      value: roleValue(effective.records.find(record => record.kind === 'webrole' && record.id === id)) ?? null,
      sourceValue: roleValue(records.find(record => record.id === id)) ?? null,
      overridden: Object.hasOwn(overrides.roles ?? {}, id), deleted: !effective.records.some(record => record.kind === 'webrole' && record.id === id),
    }));
  }
  return [...new Set([...Object.keys(source[section] ?? {}), ...Object.keys(overrides[section] ?? {})])].sort().map(name => ({
    id: name, name, value: effective[section][name] ?? null,
    sourceValue: source[section]?.[name] ?? null,
    overridden: Object.hasOwn(overrides[section] ?? {}, name),
    deleted: !Object.hasOwn(effective[section], name),
  }));
}
